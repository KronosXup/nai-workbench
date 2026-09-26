"""Request validation shared by the Gate bridge."""

from __future__ import annotations

import base64
import binascii
import copy
import json
import math
import re
import uuid

from fastapi import HTTPException

from .config import Settings
from .model_policy import effective_model_for_operation


OPERATIONS = {"generate", "img2img", "inpaint", "upscale", "augment", "encode_vibe"}


def fail(status: int, detail: str):
    raise HTTPException(status, detail)


def checked_uuid(value) -> str:
    try:
        return str(uuid.UUID(str(value)))
    except (ValueError, TypeError, AttributeError):
        fail(422, "request_id 必须是 UUID")


def _number(parameters, key, default, minimum, maximum, integral=False):
    value = parameters.get(key, default)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        fail(422, f"{key} 必须是有效数字")
    if not minimum <= value <= maximum or (integral and value != int(value)):
        fail(422, f"{key} 超出允许范围 {minimum}–{maximum}")
    parameters[key] = int(value) if integral else value


def validate_task(raw: dict, settings: Settings) -> dict:
    if not isinstance(raw, dict):
        fail(422, "任务必须是对象")
    allowed = {"request_id", "operation", "model", "prompt", "negative_prompt", "parameters", "label"}
    if set(raw) - allowed:
        fail(422, "任务包含不支持的顶层字段")
    item = copy.deepcopy(raw)
    item["request_id"] = checked_uuid(item.get("request_id"))
    operation = item.setdefault("operation", "generate")
    if not isinstance(operation, str) or operation not in OPERATIONS:
        fail(422, "不支持的操作")
    model = item.setdefault("model", "nai-diffusion-4-5-full")
    if not isinstance(model, str) or not 1 <= len(model) <= 160 or not re.fullmatch(r"[A-Za-z0-9._-]+", model):
        fail(422, "模型名称无效")
    for field in ("prompt", "negative_prompt", "label"):
        value = item.setdefault(field, "")
        if not isinstance(value, str) or len(value) > (200 if field == "label" else 100000):
            fail(422, f"{field} 必须是长度有效的文本")
    p = item.setdefault("parameters", {})
    if not isinstance(p, dict):
        fail(422, "parameters 必须是对象")
    _number(p, "width", 832, 64, 4096, True)
    _number(p, "height", 1216, 64, 4096, True)
    if operation in {"generate", "img2img", "inpaint"} and (p["width"] % 8 or p["height"] % 8):
        fail(422, "宽高必须是 8 的整数倍")
    _number(p, "steps", 28, 1, 100, True)
    _number(p, "scale", 5, 0, 30)
    _number(p, "seed", -1, -1, 4294967295, True)
    if p.get("n_samples", 1) != 1:
        fail(422, "每个任务只生成一张；多张图片请拆成独立任务批量提交")
    _number(p, "n_samples", 1, 1, 1, True)
    for field in ("strength", "noise"):
        if field in p:
            _number(p, field, 0, 0, 1)
    if "scale_factor" in p:
        _number(p, "scale_factor", 2, 1, 4)
    if "sampler" in p and (not isinstance(p["sampler"], str) or len(p["sampler"]) > 80):
        fail(422, "sampler 无效")
    if "stream" in p and type(p["stream"]) is not bool:
        fail(422, "stream 必须是布尔值")
    try:
        encoded = json.dumps(item, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()
    except (ValueError, TypeError, RecursionError):
        fail(422, "任务包含无效 JSON 值")
    if len(encoded) > settings.max_input_mb * 1024 * 1024:
        fail(413, "任务输入超过大小限制")
    image_fields = ("image", "mask")
    image_arrays = ("reference_image_multiple", "character_reference_images")
    images = []
    for field in image_fields:
        if field in p and p[field] is not None:
            images.append((field, p[field]))
    for field in image_arrays:
        if field in p:
            if not isinstance(p[field], list) or len(p[field]) > 16:
                fail(422, f"{field} 必须是最多 16 项的数组")
            images.extend((field, image) for image in p[field])
    for field, image in images:
        if not isinstance(image, str) or not image or image.startswith("data:"):
            fail(422, f"{field} 必须是无 data URI 前缀的 base64")
        try:
            base64.b64decode(image, validate=True)
        except (ValueError, binascii.Error):
            fail(422, f"{field} 的 base64 无效")
    for field in ("reference_strength_multiple", "reference_information_extracted_multiple"):
        if field in p:
            values = p[field]
            if not isinstance(values, list) or any(isinstance(x, bool) or not isinstance(x, (int, float)) or
                                                    not math.isfinite(x) or not 0 <= x <= 1 for x in values):
                fail(422, f"{field} 必须是 0–1 的数组")
            if len(values) != len(p.get("reference_image_multiple", [])):
                fail(422, "参考图与强度数组长度不一致")
    precise_count = len(p.get("character_reference_images", []))
    for field in ("character_reference_descriptions", "character_reference_strengths", "character_reference_fidelities"):
        if field not in p:
            continue
        values = p[field]
        # Missing trailing settings use the adapter's defaults. Never accept
        # excess settings that would otherwise disappear during translation.
        if not isinstance(values, list) or len(values) > precise_count:
            fail(422, f"{field} 必须是数组，且数量不能超过精确参考图片")
        if field == "character_reference_descriptions":
            if any(not isinstance(value, str) or value not in {"character", "style", "character&style"}
                   for value in values):
                fail(422, "精确参考类型必须是 character、style 或 character&style")
        elif any(isinstance(value, bool) or not isinstance(value, (int, float)) or
                 not math.isfinite(value) or not 0 <= value <= 1 for value in values):
            fail(422, f"{field} 必须是 0–1 的数组")
    if operation in {"generate", "img2img", "inpaint"}:
        capability_model = effective_model_for_operation(model, operation)
        has_precise = bool(precise_count or p.get("director_reference_images") or
                           p.get("director_reference_images_cached"))
        has_vibe = bool(p.get("reference_image_multiple") or p.get("reference_image_multiple_cached"))
        if has_precise and not capability_model.startswith("nai-diffusion-4-5-"):
            fail(422, "当前模型不支持精确参考，请使用 V4.5")
        if has_precise and has_vibe:
            fail(422, "精确参考与 Vibe 不能同时启用")
        if has_vibe and capability_model.startswith("nai-diffusion-5-"):
            fail(422, "当前 V5 模型不支持 Vibe，请选择支持的模型")
    if operation == "encode_vibe" and model.startswith("nai-diffusion-5-"):
        fail(422, "当前 V5 模型不支持 Vibe 编码，请选择支持的模型")
    if "character_prompts" in p:
        chars = p["character_prompts"]
        capability_model = effective_model_for_operation(model, operation)
        character_limit = 32 if capability_model.startswith("nai-diffusion-5-") else (6 if capability_model.startswith("nai-diffusion-4-") else 0)
        if not isinstance(chars, list) or len(chars) > character_limit:
            fail(422, f"此模型最多接受 {character_limit} 项独立角色提示词")
        for char in chars:
            if not isinstance(char, dict) or not isinstance(char.get("prompt", ""), str):
                fail(422, "角色提示词无效")
            for axis in ("x", "y"):
                if axis in char:
                    _number(char, axis, 0.5, 0, 1)
    if operation in {"img2img", "inpaint", "upscale", "augment", "encode_vibe"} and not p.get("image"):
        fail(422, "此操作需要输入图片")
    if operation == "inpaint" and not p.get("mask"):
        fail(422, "局部重绘需要蒙版")
    return item
