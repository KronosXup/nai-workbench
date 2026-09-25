"""Independent upstream adapters. Mock never contacts NovelAI.

The live adapter is deliberately conservative about interrupted requests: it never
retries a generation, and a preview is never accepted as a completed result.
"""
from __future__ import annotations

import asyncio
import base64
import binascii
import copy
import hashlib
import hmac
import io
import json
import math
import re
import secrets
import zipfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import PurePosixPath
from typing import Any

import httpx
from PIL import Image, ImageDraw, PngImagePlugin
from .model_policy import request_model_for_operation


MAX_RESPONSE = 96 * 1024 * 1024
MAX_IMAGE_PIXELS = 20_000_000
MAX_ARTIFACTS = 32
DIRECTOR_TOOLS = {"bg-removal", "lineart", "sketch", "colorize", "emotion", "declutter", "declutter-keep-bubbles"}
REFERENCE_CANVASES = ((1024, 1536), (1536, 1024), (1472, 1472))
_REFERENCE_CACHE_SECRET = secrets.token_bytes(32)


@dataclass
class Artifact:
    data: bytes
    media_type: str = "image/png"
    filename: str = "image.png"
    metadata: dict = field(default_factory=dict)


class AdapterError(Exception):
    def __init__(self, code: str, message: str, uncertain: bool = False, retry_after: float | None = None, retryable: bool = False):
        super().__init__(message)
        self.code = code
        self.message = message
        self.uncertain = uncertain
        self.retry_after = retry_after
        self.retryable = retryable and not uncertain


def retry_delay(value: str | None, default: float = 60) -> float:
    """Accept a Retry-After duration or HTTP date, with a bounded wait."""
    try:
        delay = float(value)
    except (TypeError, ValueError):
        try:
            date = parsedate_to_datetime(value)
            if date.tzinfo is None:
                date = date.replace(tzinfo=timezone.utc)
            delay = (date - datetime.now(timezone.utc)).total_seconds()
        except (TypeError, ValueError, OverflowError):
            delay = default
    return max(1, min(3600, delay)) if math.isfinite(delay) and delay >= 0 else default


def gate_rejection(payload: Any, retry_after: str | None) -> AdapterError | None:
    """Only recognize Gate's pre-dispatch 429 messages; never echo a body."""
    if not isinstance(payload, dict):
        return None
    error = payload.get("error")
    if isinstance(error, dict) and error.get("status") == 429:
        message = error.get("message")
    elif isinstance(error, str) and payload.get("message") == error:
        # Gate's queued streaming request can fail before its SSE response starts.
        message = error
    else:
        return None
    if not isinstance(message, str):
        return None
    if re.fullmatch(r"请求过于频繁（上限 [0-9]+ 次/分钟），请稍后再试", message):
        return AdapterError("gate_rpm", "请求达到每分钟上限，等待后自动继续", retry_after=retry_delay(retry_after), retryable=True)
    cooldown = re.fullmatch(r"上游图片服务限流保护中，所有图片生成暂停约 ([0-9]+) 秒", message)
    if cooldown:
        delay = retry_delay(retry_after, retry_delay(cooldown[1]))
        return AdapterError("gate_cooldown", "图片服务正在冷却，等待后自动继续", retry_after=delay, retryable=True)
    if message == "当前排队人数过多，请稍后再试":
        return AdapterError("gate_busy", "服务排队繁忙，等待后自动继续", retry_after=retry_delay(retry_after), retryable=True)
    return None


def decode_base64(value: str) -> bytes:
    if not isinstance(value, str) or len(value) > MAX_RESPONSE * 4 // 3 + 128:
        raise AdapterError("invalid_image", "图片内容为空或超过大小限制")
    if value.startswith("data:"):
        value = value.split(",", 1)[-1]
    try:
        return base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise AdapterError("invalid_image", "图片编码不完整") from exc


def image_artifact(data: bytes, filename: str = "image.png") -> Artifact:
    try:
        with Image.open(io.BytesIO(data)) as im:
            if im.width * im.height > MAX_IMAGE_PIXELS:
                raise ValueError("oversize")
            kind = im.format
            dimensions = {"width": im.width, "height": im.height}
            im.verify()
    except Exception as exc:
        raise AdapterError("invalid_result", "上游结果不是完整的受支持图片", uncertain=True) from exc
    mime = {"PNG": "image/png", "JPEG": "image/jpeg", "WEBP": "image/webp"}.get(kind)
    if mime is None:
        raise AdapterError("invalid_result", "上游返回了不支持的图片格式", uncertain=True)
    suffix = {"PNG": ".png", "JPEG": ".jpg", "WEBP": ".webp"}[kind]
    return Artifact(data, mime, PurePosixPath(filename).stem[:80] + suffix, dimensions)


def unpack_images(data: bytes) -> list[Artifact]:
    if len(data) > MAX_RESPONSE:
        raise AdapterError("result_too_large", "上游结果超过保存限制", uncertain=True)
    if not data.startswith(b"PK"):
        return [image_artifact(data)]
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            members = [m for m in archive.infolist() if not m.is_dir()]
            if not members or len(members) > MAX_ARTIFACTS or sum(m.file_size for m in members) > MAX_RESPONSE:
                raise ValueError("archive limits")
            results = []
            for item in members:
                if item.flag_bits & 1:
                    raise ValueError("encrypted archive")
                if PurePosixPath(item.filename).suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp"}:
                    continue
                # Read to memory only; archive paths never reach the filesystem.
                results.append(image_artifact(archive.read(item), PurePosixPath(item.filename).name))
            if not results:
                raise ValueError("no image")
            return results
    except AdapterError:
        raise
    except Exception as exc:
        raise AdapterError("invalid_archive", "上游图片包不完整或超过限制", uncertain=True) from exc


def validate_input_image(value: str) -> bytes:
    data = decode_base64(value)
    try:
        image_artifact(data)
    except AdapterError as exc:
        # This is before any request. A bad upload cannot consume NAI quota.
        raise AdapterError("invalid_image", "输入图片不完整或格式不受支持") from exc
    return data


def prepare_precise_reference(value: str) -> str:
    """Apply the documented canvas geometry, without claiming pixel parity."""
    data = validate_input_image(value)
    with Image.open(io.BytesIO(data)) as source:
        target = min(REFERENCE_CANVASES, key=lambda size: abs(source.width / source.height - size[0] / size[1]))
        factor = min(target[0] / source.width, target[1] / source.height)
        # Match positive Math.round geometry; the resampling filter is ours.
        size = tuple(max(1, math.floor(length * factor + .5)) for length in source.size)
        offset = tuple(math.floor((extent - length) / 2 + .5) for extent, length in zip(target, size))
        canvas = Image.new("RGB", target, "black")
        resized = source.convert("RGBA").resize(size, Image.Resampling.LANCZOS)
        canvas.paste(resized, offset, resized)
        stream = io.BytesIO()
        canvas.save(stream, format="PNG")
    return base64.b64encode(stream.getvalue()).decode("ascii")


def map_precise_references(params: dict, model: str):
    images = params.pop("character_reference_images", [])
    descriptions = params.pop("character_reference_descriptions", [])
    strengths = params.pop("character_reference_strengths", [])
    fidelities = params.pop("character_reference_fidelities", [])
    if not images:
        return
    if not model.startswith("nai-diffusion-4-5-"):
        raise AdapterError("unsupported_reference", "当前模型不支持精确参考，请使用 V4.5")
    if params.get("reference_image_multiple") or params.get("reference_image_multiple_cached"):
        raise AdapterError("incompatible_references", "精确参考与 Vibe 不能同时启用")
    if not isinstance(images, list) or len(images) > 16 or any(not isinstance(values, list) or len(values) > len(images) for values in (descriptions, strengths, fidelities)):
        raise AdapterError("invalid_reference", "精确参考图片与设置数量不匹配")
    cached, captions, weights, secondary = [], [], [], []
    for index, value in enumerate(images):
        description = descriptions[index] if index < len(descriptions) else "character"
        strength = strengths[index] if index < len(strengths) else 1
        fidelity = fidelities[index] if index < len(fidelities) else 1
        if description not in {"character", "style", "character&style"} or not all(isinstance(number, (float, int)) and not isinstance(number, bool) and math.isfinite(number) and 0 <= number <= 1 for number in (strength, fidelity)):
            raise AdapterError("invalid_reference", "精确参考类型无效，或强度与保真度不在 0 到 1 之间")
        encoded = prepare_precise_reference(value)
        cached.append({"cache_secret_key": hmac.new(_REFERENCE_CACHE_SECRET, encoded.encode("ascii"), hashlib.sha256).hexdigest(), "data": encoded})
        captions.append({"caption": {"base_caption": description, "char_captions": []}, "legacy_uc": False})
        weights.append(strength)
        secondary.append(1 - fidelity)
    # Official legacy JSON transport keeps full base64 data in cached items.
    params["director_reference_images_cached"] = cached
    params["director_reference_descriptions"] = captions
    params["director_reference_information_extracted"] = [1] * len(images)
    params["director_reference_strength_values"] = weights
    params["director_reference_secondary_strength_values"] = secondary


def build_request(job: dict) -> tuple[str, dict, bool]:
    """Translate our stable document into the upstream request shape.

    Arbitrary model parameters are retained; local-only UI fields are translated
    explicitly. Capability support still requires a real upstream acceptance run.
    """
    operation = job["operation"]
    params = copy.deepcopy(job.get("parameters", {}))
    for local_field in ("vibe_encodings", "vibe_pending_indices", "vibe_source_images", "source_width", "source_height"):
        params.pop(local_field, None)
    model = str(job.get("model") or "nai-diffusion-4-5-full")
    prompt = str(job.get("prompt", ""))
    negative = str(job.get("negative_prompt", ""))
    stream = bool(params.pop("stream", False))
    if operation in {"upscale", "augment", "encode_vibe", "img2img", "inpaint"}:
        if not params.get("image"):
            raise AdapterError("image_required", "这个操作需要输入图片")
        validate_input_image(params["image"])
    if operation == "upscale":
        factor = params.get("scale_factor", 2)
        if type(factor) is not int or factor != 2:
            raise AdapterError("invalid_scale", "当前放大接口仅支持 2 倍")
        return "/ai/upscale", {"image": params["image"], "model": "nai-diffusion-5-curated", "declared_blur_sigma": 0}, False
    if operation == "augment":
        tool = params.get("req_type", "lineart")
        if tool not in DIRECTOR_TOOLS:
            raise AdapterError("invalid_tool", "不支持的导演工具")
        with Image.open(io.BytesIO(decode_base64(params["image"]))) as source:
            width, height = source.size
        body = {"image": params["image"], "width": width, "height": height, "req_type": tool, "prompt": prompt}
        if tool in {"colorize", "emotion"}:
            body["defry"] = params.get("defry", 0)
        if tool == "emotion":
            body["prompt"] = str(params.get("emotion") or "neutral") + ";;" + prompt
        return "/ai/augment-image", body, False
    if operation == "encode_vibe":
        extracted = params.get("information_extracted", params.get("informationExtracted", 1.0))
        if not isinstance(extracted, (int, float)) or not math.isfinite(extracted) or not 0 <= extracted <= 1:
            raise AdapterError("invalid_reference", "信息提取量应在 0 到 1 之间")
        return "/ai/encode-vibe", {"image": params["image"], "model": model, "informationExtracted": extracted}, False
    if operation not in {"generate", "img2img", "inpaint"}:
        raise AdapterError("unsupported_operation", "不支持的生成操作")
    if operation == "inpaint":
        if not params.get("mask"):
            raise AdapterError("mask_required", "局部重绘需要蒙版")
        validate_input_image(params["mask"])
        model = request_model_for_operation(model, operation)
    characters = params.pop("character_prompts", [])
    map_precise_references(params, model)
    if (params.get("director_reference_images") or params.get("director_reference_images_cached")) and params.get("reference_image_multiple"):
        raise AdapterError("incompatible_references", "精确参考与 Vibe 不能同时启用")
    if any(isinstance(v, str) and v.startswith("MOCK:") for v in params.get("reference_image_multiple", [])):
        raise AdapterError("mock_reference", "演示编码不能发送给真实 NAI")
    params["n_samples"] = 1
    params["negative_prompt"] = negative
    params["uc"] = negative
    params.setdefault("noise_schedule", "karras")
    params.setdefault("params_version", 3 if operation != "inpaint" else 4)
    if "diffusion-4" in model or "diffusion-5" in model:
        coords = bool(params.get("use_coords", False))
        caps, uc_caps = [], []
        for character in characters:
            if character.get("enabled", True) is False:
                continue
            x, y = character.get("x", 0.5), character.get("y", 0.5)
            if not all(isinstance(v, (int, float)) and math.isfinite(v) and 0 <= v <= 1 for v in (x, y)):
                raise AdapterError("invalid_character_position", "角色位置应在画布范围内")
            centers = [{"x": x, "y": y}]
            caps.append({"char_caption": character.get("prompt", ""), "centers": centers})
            uc_caps.append({"char_caption": character.get("negative_prompt", ""), "centers": centers})
        params["v4_prompt"] = {"caption": {"base_caption": prompt, "char_captions": caps}, "use_coords": coords, "use_order": True}
        params["v4_negative_prompt"] = {"caption": {"base_caption": negative, "char_captions": uc_caps}, "use_coords": coords, "use_order": False}
    body = {"input": prompt, "model": model, "action": {"generate": "generate", "img2img": "img2img", "inpaint": "infill"}[operation], "parameters": params}
    return "/ai/generate-image-stream" if stream else "/ai/generate-image", body, stream


class NaiAdapter:
    def __init__(self, settings: Any, transport=None, *, gate_mode: bool = False):
        self.settings = settings
        self.gate_mode = gate_mode
        self.client = httpx.AsyncClient(
            base_url=settings.nai_base_url.rstrip("/"),
            timeout=httpx.Timeout(settings.upstream_timeout, connect=15),
            follow_redirects=False,
            headers={"Authorization": f"Bearer {settings.nai_token}", "User-Agent": "NAI-Workbench/0.1"},
            transport=transport,
        )

    async def close(self):
        await self.client.aclose()

    async def execute(self, job: dict, on_preview=None) -> list[Artifact]:
        if not self.settings.nai_token:
            raise AdapterError("not_configured", "部署者尚未配置 NAI 连接")
        path, body, use_stream = build_request(job)
        try:
            async with self.client.stream("POST", path, json=body) as response:
                if response.status_code not in {200, 201}:
                    # Never forward raw upstream bodies: they may echo private input.
                    status = response.status_code
                    retry_after = None
                    if status == 429:
                        retry_after = retry_delay(response.headers.get("retry-after"))
                        if self.gate_mode:
                            # Bound the diagnostic body before parsing. Upstream text is
                            # untrusted and is never used as a user-visible message.
                            raw = bytearray()
                            async for chunk in response.aiter_bytes():
                                raw.extend(chunk[:8193 - len(raw)])
                                if len(raw) > 8192:
                                    break
                            if len(raw) <= 8192:
                                try:
                                    rejection = gate_rejection(json.loads(raw), response.headers.get("retry-after"))
                                except (ValueError, RecursionError):
                                    rejection = None
                                if rejection:
                                    raise rejection
                    message = {401: "NAI 凭据无效", 402: "NAI 额度不足", 403: "NAI 拒绝访问", 429: "NAI 正在限流，请稍后再试"}.get(status, f"NAI 返回错误状态 {status}")
                    if self.gate_mode and status == 429:
                        message = "Gate 拒绝了本次请求，请核对额度或稍后再试"
                    raise AdapterError(f"upstream_{status}", message, uncertain=status >= 500, retry_after=retry_after)
                if "text/event-stream" in response.headers.get("content-type", ""):
                    return await self._read_stream(response, on_preview)
                parts, size = [], 0
                async for chunk in response.aiter_bytes():
                    size += len(chunk)
                    if size > MAX_RESPONSE:
                        raise AdapterError("result_too_large", "上游结果超过保存限制", uncertain=True)
                    parts.append(chunk)
                data = b"".join(parts)
                if job["operation"] == "encode_vibe":
                    if not data:
                        raise AdapterError("empty_result", "NAI 没有返回编码", uncertain=True)
                    content_type = response.headers.get("content-type", "").split(";", 1)[0]
                    if content_type == "application/json":
                        try:
                            parsed = json.loads(data)
                        except ValueError as exc:
                            raise AdapterError("invalid_encoding", "NAI 返回的编码不完整", uncertain=True) from exc
                        return [Artifact(json.dumps(parsed).encode(), "application/json", "vibe.json", {"kind": "vibe", "model": job["model"]})]
                    encoded = base64.b64encode(data).decode()
                    return [Artifact(json.dumps({"encoding": encoded, "model": job["model"], "information_extracted": body["informationExtracted"]}).encode(), "application/json", "vibe.json", {"kind": "vibe"})]
                if "application/json" in response.headers.get("content-type", ""):
                    try:
                        payload = json.loads(data)
                    except ValueError as exc:
                        raise AdapterError("invalid_result", "NAI 返回的结果不完整", uncertain=True) from exc
                    if not isinstance(payload, dict) or payload.get("error") or payload.get("final") is not True or not payload.get("image"):
                        raise AdapterError("missing_final", "NAI 未返回明确的完整最终图片", uncertain=True)
                    return unpack_images(decode_base64(payload["image"]))
                return unpack_images(data)
        except AdapterError:
            raise
        except httpx.ConnectError as exc:
            raise AdapterError("connection_failed", "未能连接 NAI，本次未自动重试") from exc
        except httpx.ConnectTimeout as exc:
            raise AdapterError("connection_timeout", "连接 NAI 超时，本次未自动重试") from exc
        except (httpx.TimeoutException, httpx.NetworkError, httpx.RemoteProtocolError) as exc:
            raise AdapterError("upstream_interrupted", "NAI 请求中断，结果待确认；为避免重复消耗未自动重试", uncertain=True) from exc

    async def _read_stream(self, response, on_preview) -> list[Artifact]:
        event_name, data_lines, total = "", [], 0
        final: list[Artifact] = []

        async def consume() -> bool:
            nonlocal final
            if not data_lines:
                return False
            raw = "\n".join(data_lines)
            if raw == "[DONE]":
                return False
            try:
                payload = json.loads(raw)
            except ValueError as exc:
                raise AdapterError("invalid_stream", "NAI 流式结果不完整", uncertain=True) from exc
            if not isinstance(payload, dict):
                raise AdapterError("invalid_stream", "NAI 流式结果格式无效", uncertain=True)
            kind = event_name or payload.get("event_type") or payload.get("event")
            if kind == "error" or payload.get("error"):
                raise AdapterError("stream_error", "NAI 流式任务返回错误", uncertain=True)
            value = payload.get("image") or payload.get("document") or payload.get("b64")
            if kind in {"final", "done", "result", "complete"} or payload.get("final") is True:
                if not value:
                    raise AdapterError("missing_final", "NAI 未返回明确的完整最终图片", uncertain=True)
                try:
                    final = unpack_images(decode_base64(value))
                except AdapterError as exc:
                    raise AdapterError(exc.code, exc.message, uncertain=True) from exc
                return True
            elif (kind in {"intermediate", "preview"} or payload.get("final") is False) and on_preview:
                if not value:
                    return False
                image = image_artifact(decode_base64(value))
                await on_preview({"image": base64.b64encode(image.data).decode(), "media_type": image.media_type, "step": payload.get("step")})
            return False

        async for line in response.aiter_lines():
            total += len(line)
            if total > MAX_RESPONSE * 8:
                raise AdapterError("stream_too_large", "流式结果超过限制", uncertain=True)
            if not line:
                if await consume():
                    return final
                event_name, data_lines = "", []
            elif line.startswith("event:"):
                event_name = line[6:].strip()
            elif line.startswith("data:"):
                data_lines.append(line[5:].lstrip())
                if sum(map(len, data_lines)) > MAX_RESPONSE * 4 // 3:
                    raise AdapterError("frame_too_large", "流式帧超过限制", uncertain=True)
        if await consume():
            return final
        if not final:
            raise AdapterError("missing_final", "只收到预览，未收到完整最终图片；结果待确认", uncertain=True)
        return final


class MockAdapter:
    """A visibly labelled deterministic diagnostic image, never a fake NAI result."""
    def __init__(self, settings: Any):
        self.delay = max(0, float(settings.mock_delay))

    async def close(self):
        pass

    async def execute(self, job: dict, on_preview=None) -> list[Artifact]:
        await asyncio.sleep(self.delay)
        p = job.get("parameters", {})
        if job["operation"] == "encode_vibe":
            body = {"encoding": "MOCK:" + hashlib.sha256(str(p.get("image", "")).encode()).hexdigest(), "model": job["model"], "mock": True}
            return [Artifact(json.dumps(body).encode(), "application/json", "mock-vibe.json", {"mock": True, "kind": "vibe"})]
        width, height = int(p.get("width", 832)), int(p.get("height", 1216))
        # Keep the requested geometry; this diagnostic rendering is not inference.
        im = Image.new("RGB", (width, height), "#e7e6e2")
        d = ImageDraw.Draw(im)
        margin = max(24, width // 18)
        for x in range(0, width, 48):
            d.line((x, 0, x, height), fill="#dadad5")
        for y in range(0, height, 48):
            d.line((0, y, width, y), fill="#dadad5")
        d.rectangle((margin, margin, width-margin, height-margin), outline="#565957", width=2)
        d.rectangle((margin, margin, width-margin, margin+max(60, height//12)), fill="#333936")
        font_size = max(14, min(width//28, 38))
        d.text((margin+16, margin+18), "LOCAL TEST / NO NAI REQUEST", fill="#f5ef40", font_size=font_size)
        cy, radius = height//2, min(width//3, height//4)
        for r in range(radius, max(1, radius-48), -8):
            d.ellipse((width//2-r, cy-r, width//2+r, cy+r), outline="#a7aaa2", width=1)
        d.line((width//2-radius-20, cy, width//2+radius+20, cy), fill="#6d7269", width=2)
        d.line((width//2, cy-radius-20, width//2, cy+radius+20), fill="#6d7269", width=2)
        d.text((margin+16, height-margin-100), f"{width} x {height}  /  SEED {p.get('seed', 0)}", fill="#373e39", font_size=font_size)
        d.text((margin+16, height-margin-65), "Storage & queue diagnostic", fill="#697066", font_size=font_size)
        info = PngImagePlugin.PngInfo()
        info.add_text("Software", "NAI Workbench local mock - not generated by NAI")
        info.add_text("Comment", json.dumps({"mock": True, "seed": p.get("seed"), "operation": job["operation"]}))
        out = io.BytesIO()
        im.save(out, format="PNG", pnginfo=info)
        if p.get("stream") and on_preview:
            await on_preview({"image": base64.b64encode(out.getvalue()).decode(), "media_type": "image/png", "step": 1})
            await asyncio.sleep(self.delay)
        return [Artifact(out.getvalue(), metadata={"mock": True, "width": width, "height": height})]


def create_adapter(settings):
    if settings.upstream_mode == "mock":
        return MockAdapter(settings)
    if settings.upstream_mode == "nai":
        return NaiAdapter(settings)
    raise ValueError("upstream_mode must be mock or nai")
