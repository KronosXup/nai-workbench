from __future__ import annotations

import asyncio
import base64
import binascii
import copy
import hashlib
import json
import math
import os
import re
import secrets
import shutil
import time
import uuid
from pathlib import Path

from fastapi import HTTPException

from .config import Settings
from .database import Store, compact, token_hash
from .model_policy import effective_model_for_operation


OPERATIONS = {"generate", "img2img", "inpaint", "upscale", "augment", "encode_vibe"}
TERMINAL = {"succeeded", "failed", "unknown", "cancelled"}
POLICIES = {"retain_until_expiry", "delete_after_ack"}


def fail(status: int, detail: str):
    raise HTTPException(status, detail)


def fingerprint(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                    separators=(",", ":"), allow_nan=False).encode()).hexdigest()


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
    try:
        encoded = compact(item).encode()
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


def quote_task(item: dict) -> dict:
    p = item["parameters"]
    pixels = p["width"] * p["height"]
    units = max(1, math.ceil(pixels / (1024 * 1024) * p["steps"] / 28)) * p["n_samples"]
    if item["operation"] in {"upscale", "augment"}:
        units *= 2
    return {"units": units, "unit_label": "本地使用单位", "verified": False,
            "message": "本站本地限额估算，不是 NovelAI Anlas 报价；真实上游费用尚未核验。"}


class Service:
    def __init__(self, settings: Settings, adapter):
        self.settings = settings
        self.adapter = adapter
        self.store = Store(settings)
        self.files = settings.data_dir / "results"
        self.staging = settings.data_dir / "staging"
        self.files.mkdir(exist_ok=True)
        self.staging.mkdir(exist_ok=True)
        self.previews: dict[str, dict] = {}
        self.wake = asyncio.Event()
        self.tasks = []
        self.stopping = False
        self.degraded_error = None
        self.recover()

    def authenticate(self, token):
        user = self.store.authenticate(token)
        if not user:
            fail(401, "访问凭据无效或已停用")
        return dict(user)

    def me(self, user):
        row = self.store.one("SELECT * FROM users WHERE id=?", (user["id"],))
        policy = self.store.policy()
        return {"id": row["id"], "name": row["name"], "is_admin": bool(row["is_admin"]),
                "quota": {"limit": row["quota_limit"], "used": row["quota_used"],
                          "reserved": row["quota_reserved"],
                          "remaining": max(0, row["quota_limit"] - row["quota_used"] - row["quota_reserved"])},
                "storage_policy": {"mode": policy["mode"], "retention_hours": policy["retention_hours"]}}

    def _get_job(self, owner, job_id):
        row = self.store.one("SELECT * FROM jobs WHERE id=? AND owner_id=?", (job_id, owner))
        if row is None:
            fail(404, "任务不存在")
        return row

    def job(self, owner, job_id):
        row = self._get_job(owner, job_id)
        output = {key: row[key] for key in (
            "id", "request_id", "operation", "model", "prompt", "negative_prompt", "label", "status",
            "created_at", "started_at", "completed_at", "error", "quota_units", "storage_mode", "retention_hours",
        )}
        output["parameters"] = json.loads(row["parameters"])
        output["results"] = [self.result_view(result) for result in self.store.all(
            "SELECT * FROM results WHERE job_id=? AND owner_id=? ORDER BY rowid", (job_id, owner))]
        if row["status"] == "running" and job_id in self.previews:
            output["preview"] = self.previews[job_id]
        return output

    @staticmethod
    def result_view(row):
        value = {key: row[key] for key in (
            "id", "job_id", "media_type", "filename", "sha256", "size", "expires_at",
        )}
        value.update(deleted=bool(row["deleted"]), acknowledged=bool(row["acknowledged"]),
                     metadata=json.loads(row["metadata"]))
        return value

    def jobs(self, owner):
        return {"jobs": [self.job(owner, row["id"]) for row in self.store.all(
            "SELECT id FROM jobs WHERE owner_id=? ORDER BY seq DESC LIMIT 200", (owner,))]}

    def _storage_usage(self, db):
        # Count bytes still on disk, including tombstones whose unlink previously failed.
        # A logical deletion alone must not make a full data directory appear empty.
        retained = sum(path.stat().st_size for directory in (self.files, self.staging)
                       for path in directory.iterdir() if path.is_file())
        inputs, reserved = db.execute(
            "SELECT COALESCE(SUM(input_bytes),0),COALESCE(SUM(storage_reserve),0) FROM jobs").fetchone()
        return int(retained + inputs + reserved)

    def _insert(self, db, owner, item, policy):
        digest = fingerprint(item)
        existing = db.execute("SELECT id,fingerprint FROM jobs WHERE owner_id=? AND request_id=?",
                              (owner, item["request_id"])).fetchone()
        if existing:
            if existing["fingerprint"] != digest:
                fail(409, "同一个 request_id 已用于不同任务")
            return existing["id"]
        pending = db.execute("SELECT COUNT(*) FROM jobs WHERE owner_id=? AND status IN ('queued','running')",
                             (owner,)).fetchone()[0]
        if pending >= policy["max_pending_per_user"]:
            fail(429, "个人待处理任务已达上限")
        units = quote_task(item)["units"]
        user = db.execute("SELECT * FROM users WHERE id=?", (owner,)).fetchone()
        if user["quota_used"] + user["quota_reserved"] + units > user["quota_limit"]:
            fail(409, "本地使用额度不足，含已排队预占额度")
        item = copy.deepcopy(item)
        if item["parameters"]["seed"] == -1:
            item["parameters"]["seed"] = secrets.randbelow(2**32)
        params = compact(item["parameters"])
        input_bytes = len(compact(item).encode())
        p = item["parameters"]
        factor = p.get("scale_factor", 2) ** 2 if item["operation"] == "upscale" else 1
        reserve = math.ceil(p["width"] * p["height"] * 4 * factor * p["n_samples"] + 256 * 1024)
        if item["operation"] == "encode_vibe":
            reserve = max(reserve, 8 * 1024 * 1024)
        if self._storage_usage(db) + input_bytes + reserve > policy["max_storage_mb"] * 1024 * 1024:
            fail(507, "临时存储容量不足，请等待到期清理或删除已有副本")
        if shutil.disk_usage(self.settings.data_dir).free < input_bytes + reserve + 1024 * 1024:
            fail(507, "服务器可用磁盘空间不足")
        job_id = str(uuid.uuid4())
        now = time.time()
        db.execute("""INSERT INTO jobs(id,owner_id,request_id,fingerprint,operation,model,prompt,
            negative_prompt,parameters,label,status,created_at,quota_units,storage_mode,retention_hours,
            input_bytes,storage_reserve) VALUES(?,?,?,?,?,?,?,?,?,?,'queued',?,?,?,?,?,?)""",
            (job_id, owner, item["request_id"], digest, item["operation"], item["model"], item["prompt"],
             item["negative_prompt"], params, item["label"], now, units, policy["mode"],
             policy["retention_hours"], input_bytes, reserve))
        db.execute("UPDATE users SET quota_reserved=quota_reserved+? WHERE id=?", (units, owner))
        db.execute("INSERT INTO quota_ledger(job_id,owner_id,event,units,created_at) VALUES(?,?,'reserve',?,?)",
                   (job_id, owner, units, now))
        return job_id

    def submit(self, owner, raw):
        if self.degraded_error:
            fail(503, "后台执行器需要检查，暂停接收新任务")
        if self.settings.upstream_mode == "nai" and not self.settings.nai_token:
            fail(503, "尚未配置 NovelAI 上游凭据")
        item = validate_task(raw, self.settings)
        self._cleanup(time.time())
        with self.store.transaction() as db:
            job_id = self._insert(db, owner, item, self.store.policy())
        self.wake.set()
        return self.job(owner, job_id)

    def submit_batch(self, owner, raw):
        if self.degraded_error:
            fail(503, "后台执行器需要检查，暂停接收新任务")
        if not isinstance(raw, dict) or set(raw) - {"request_id", "items"}:
            fail(422, "批量提交格式无效")
        request_id = checked_uuid(raw.get("request_id"))
        items = raw.get("items")
        if not isinstance(items, list) or not 1 <= len(items) <= 100:
            fail(422, "批量任务需要 1–100 个条目")
        if self.settings.upstream_mode == "nai" and not self.settings.nai_token:
            fail(503, "尚未配置 NovelAI 上游凭据")
        items = [validate_task(item, self.settings) for item in items]
        if len({item["request_id"] for item in items}) != len(items):
            fail(422, "批量中的每个任务必须使用不同 request_id")
        digest = fingerprint(items)
        self._cleanup(time.time())
        with self.store.transaction() as db:
            previous = db.execute("SELECT * FROM batches WHERE owner_id=? AND request_id=?",
                                  (owner, request_id)).fetchone()
            if previous:
                if previous["fingerprint"] != digest:
                    fail(409, "同一个批次 request_id 已用于不同内容")
                ids = json.loads(previous["job_ids"])
            else:
                policy = self.store.policy()
                ids = [self._insert(db, owner, item, policy) for item in items]
                db.execute("INSERT INTO batches VALUES(?,?,?,?)", (owner, request_id, digest, compact(ids)))
        self.wake.set()
        return {"jobs": [self.job(owner, job_id) for job_id in ids]}

    def _settle(self, db, row, settle: bool):
        if row["quota_state"] != "reserved":
            return
        event = "settle" if settle else "release"
        db.execute("UPDATE users SET quota_reserved=MAX(0,quota_reserved-?),quota_used=quota_used+? WHERE id=?",
                   (row["quota_units"], row["quota_units"] if settle else 0, row["owner_id"]))
        db.execute("UPDATE jobs SET quota_state=? WHERE id=?", ("settled" if settle else "released", row["id"]))
        db.execute("INSERT INTO quota_ledger(job_id,owner_id,event,units,created_at) VALUES(?,?,?,?,?)",
                   (row["id"], row["owner_id"], event, row["quota_units"], time.time()))

    def cancel(self, owner, job_id):
        with self.store.transaction() as db:
            row = self._get_job(owner, job_id)
            if row["status"] == "queued":
                now = time.time()
                db.execute("UPDATE jobs SET status='cancelled',completed_at=?,expires_at=?,storage_reserve=0 WHERE id=?",
                           (now, now + row["retention_hours"] * 3600, job_id))
                self._settle(db, row, False)
            elif row["status"] == "running":
                fail(409, "任务已发给上游，无法安全取消或自动退还预占额度")
        return self.job(owner, job_id)

    def _path(self, relative: str) -> Path:
        path = (self.settings.data_dir / relative).resolve()
        if not path.is_relative_to(self.files.resolve()) or path == self.files.resolve():
            raise RuntimeError("Invalid private result path")
        return path

    def _owned_result(self, owner, result_id):
        row = self.store.one("SELECT * FROM results WHERE id=? AND owner_id=?", (result_id, owner))
        if not row:
            fail(404, "结果不存在")
        return row

    def content(self, owner, result_id):
        self._cleanup(time.time())
        with self.store.lock:
            row = self._owned_result(owner, result_id)
            if row["deleted"] or row["expires_at"] <= time.time():
                fail(410, "服务器副本已删除或到期")
            try:
                data = self._path(row["path"]).read_bytes()
            except OSError:
                fail(503, "结果文件暂不可用，正在等待核对")
            if len(data) != row["size"] or hashlib.sha256(data).hexdigest() != row["sha256"]:
                fail(503, "结果完整性校验失败，未返回损坏数据")
            return data, dict(row)

    def ack(self, owner, result_id, checksum):
        if not isinstance(checksum, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", checksum):
            fail(422, "需要有效的 SHA-256 校验值")
        with self.store.transaction() as db:
            row = self._owned_result(owner, result_id)
            if not secrets.compare_digest(checksum.lower(), row["sha256"]):
                fail(409, "本地图片校验值不匹配，服务器副本已保留")
            job = db.execute("SELECT * FROM jobs WHERE id=?", (row["job_id"],)).fetchone()
            delete = bool(row["deleted"] or job["storage_mode"] == "delete_after_ack" or row["expires_at"] <= time.time())
            db.execute("UPDATE results SET acknowledged=1,deleted=?,metadata=CASE WHEN ? THEN '{}' ELSE metadata END WHERE id=?",
                       (int(delete), int(delete), result_id))
            if delete:
                self._clear_finished_content(db, job["id"])
        if delete:
            self._remove_file(row)
            self.store.checkpoint()
        return {"acknowledged": True, "deleted": delete}

    def delete(self, owner, result_id):
        with self.store.transaction() as db:
            row = self._owned_result(owner, result_id)
            db.execute("UPDATE results SET deleted=1,metadata='{}' WHERE id=?", (result_id,))
            self._clear_finished_content(db, row["job_id"])
        self._remove_file(row)
        self.store.checkpoint()
        return {"deleted": True}

    def _remove_file(self, row, strict=True):
        try:
            self._path(row["path"]).unlink(missing_ok=True)
        except OSError:
            if strict:
                fail(503, "副本已停止提供访问，磁盘清理待重试")

    @staticmethod
    def _clear_finished_content(db, job_id):
        live = db.execute("SELECT 1 FROM results WHERE job_id=? AND deleted=0 LIMIT 1", (job_id,)).fetchone()
        if not live:
            db.execute("""UPDATE jobs SET prompt='',negative_prompt='',parameters='{}',label='',
                       input_bytes=0 WHERE id=? AND status IN ('succeeded','failed','cancelled','unknown')""", (job_id,))

    def update_policy(self, raw):
        expected = {"mode", "retention_hours", "max_pending_per_user", "max_storage_mb"}
        if not isinstance(raw, dict) or set(raw) != expected:
            fail(422, "暂存设置字段不完整或包含未知字段")
        if not isinstance(raw["mode"], str) or raw["mode"] not in POLICIES:
            fail(422, "暂存策略无效")
        for field, low, high, integer in (("retention_hours", 0.00001, 8760, False),
                                         ("max_pending_per_user", 1, 1000, True),
                                         ("max_storage_mb", 0.001, 1048576, False)):
            _number(raw, field, 0, low, high, integer)
        with self.store.transaction() as db:
            if self._storage_usage(db) > raw["max_storage_mb"] * 1024 * 1024:
                fail(409, "新容量小于现有内容和任务预留，不能提前删除副本")
            db.execute("UPDATE settings SET value=? WHERE id=1", (compact(raw),))
        return raw

    def status(self):
        counts = {row["status"]: row["count"] for row in self.store.all(
            "SELECT status,COUNT(*) AS count FROM jobs GROUP BY status")}
        with self.store.lock:
            storage = self._storage_usage(self.store.connection)
        state = self.store.one("SELECT * FROM scheduler WHERE id=1")
        return {"mode": self.settings.upstream_mode, "live_verified": False, "jobs": counts,
                "upstream_configured": self.settings.upstream_mode == "mock" or bool(self.settings.nai_token),
                "storage_bytes": storage, "max_storage_mb": self.store.policy()["max_storage_mb"],
                "cooldown_remaining": max(0, state["cooldown_until"] - time.time()),
                "active_workers": sum(not task.done() for task in self.tasks[:-1]),
                "healthy": not bool(self.degraded_error), "error": self.degraded_error}

    @staticmethod
    def user_view(row):
        return {"id": row["id"], "name": row["name"], "enabled": bool(row["enabled"]),
                "is_admin": bool(row["is_admin"]), "quota_limit": row["quota_limit"],
                "quota_used": row["quota_used"], "quota_reserved": row["quota_reserved"]}

    def users(self):
        return {"users": [self.user_view(row) for row in self.store.all("SELECT * FROM users ORDER BY rowid")]}

    @staticmethod
    def _user_fields(raw, creation=False):
        allowed = {"name", "quota_limit"} if creation else {"name", "quota_limit", "enabled"}
        if not isinstance(raw, dict) or not raw or set(raw) - allowed:
            fail(422, "访问用户字段无效")
        if creation and set(raw) != allowed:
            fail(422, "需要名称与使用限额")
        if "name" in raw:
            if not isinstance(raw["name"], str) or not 1 <= len(raw["name"].strip()) <= 80:
                fail(422, "用户名称需要 1–80 个字符")
            raw["name"] = raw["name"].strip()
        if "quota_limit" in raw:
            _number(raw, "quota_limit", 0, 0, 1_000_000_000)
        if "enabled" in raw and not isinstance(raw["enabled"], bool):
            fail(422, "enabled 必须为布尔值")
        return raw

    def create_user(self, raw):
        raw = self._user_fields(raw, creation=True)
        user_id, token = str(uuid.uuid4()), secrets.token_urlsafe(32)
        with self.store.transaction() as db:
            db.execute("INSERT INTO users(id,slot,name,token_hash,quota_limit) VALUES(?,?,?,?,?)",
                       (user_id, f"issued_{user_id}", raw["name"], token_hash(token), raw["quota_limit"]))
        row = self.store.one("SELECT * FROM users WHERE id=?", (user_id,))
        return {"user": self.user_view(row), "access_token": token}

    def update_user(self, user_id, raw):
        raw = self._user_fields(raw)
        with self.store.transaction() as db:
            row = db.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
            if row is None:
                fail(404, "访问用户不存在")
            if raw.get("quota_limit", row["quota_limit"]) < row["quota_used"] + row["quota_reserved"]:
                fail(409, "限额不能低于已用与预占的合计")
            if raw.get("enabled") is False and row["is_admin"] and row["enabled"]:
                count = db.execute("SELECT COUNT(*) FROM users WHERE is_admin=1 AND enabled=1").fetchone()[0]
                if count <= 1:
                    fail(409, "不能停用最后一个可用管理员")
            db.execute("UPDATE users SET name=?,quota_limit=?,enabled=? WHERE id=?",
                       (raw.get("name", row["name"]), raw.get("quota_limit", row["quota_limit"]),
                        int(raw.get("enabled", bool(row["enabled"]))), user_id))
            if raw.get("enabled") is False:
                now = time.time()
                for job in db.execute("SELECT * FROM jobs WHERE owner_id=? AND status='queued'", (user_id,)).fetchall():
                    db.execute("UPDATE jobs SET status='cancelled',completed_at=?,expires_at=?,storage_reserve=0,error='用户访问已停用' WHERE id=?",
                               (now, now + job["retention_hours"] * 3600, job["id"]))
                    self._settle(db, job, False)
        return self.user_view(self.store.one("SELECT * FROM users WHERE id=?", (user_id,)))

    def rotate_user(self, user_id):
        token = secrets.token_urlsafe(32)
        with self.store.transaction() as db:
            row = db.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
            if row is None:
                fail(404, "访问用户不存在")
            db.execute("UPDATE users SET token_hash=? WHERE id=?", (token_hash(token), user_id))
        return {"user": self.user_view(row), "access_token": token}

    def resolve_unknown(self, actor, job_id, raw):
        if not isinstance(raw, dict) or set(raw) != {"decision", "reason"}:
            fail(422, "需要 decision 与核对原因 reason")
        decision = raw["decision"]
        if not isinstance(decision, str) or decision not in {"settle", "release"}:
            fail(422, "核对决定必须是 settle 或 release")
        if not isinstance(raw["reason"], str) or not 1 <= len(raw["reason"].strip()) <= 500:
            fail(422, "核对原因需要 1–500 个字符")
        with self.store.transaction() as db:
            row = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
            if row is None:
                fail(404, "任务不存在")
            previous = db.execute("SELECT * FROM resolutions WHERE job_id=?", (job_id,)).fetchone()
            if previous:
                if previous["decision"] != decision:
                    fail(409, "该任务已经完成不同的人工核对，不可重复更改账目")
                return {"job_id": job_id, "decision": decision, "resolved": True}
            if row["status"] != "unknown" or row["quota_state"] != "reserved":
                fail(409, "只有结果未知且仍预占额度的任务需要人工核对")
            if (self.staging / f"{job_id}.json").exists():
                fail(409, "存在待恢复的完整结果，请先重启恢复结果，再核对账目")
            self._settle(db, row, decision == "settle")
            reason = self._safe_error(raw["reason"].strip())
            db.execute("INSERT INTO resolutions(job_id,actor_id,decision,reason,created_at) VALUES(?,?,?,?,?)",
                       (job_id, actor, decision, reason, time.time()))
            db.execute("UPDATE jobs SET error=? WHERE id=?",
                       ("结果未知；管理员已核对并" + ("结算本站预占额度" if decision == "settle" else "释放本站预占额度"), job_id))
        return {"job_id": job_id, "decision": decision, "resolved": True}

    def _claim(self):
        with self.store.transaction() as db:
            now = time.time()
            state = db.execute("SELECT * FROM scheduler WHERE id=1").fetchone()
            if max(state["next_dispatch_at"], state["cooldown_until"]) > now:
                return None
            # Least recently served identity first, then FIFO within that identity.
            row = db.execute("""SELECT j.* FROM jobs j JOIN users u ON u.id=j.owner_id
                WHERE j.status='queued' AND u.enabled=1 ORDER BY u.last_scheduled,j.seq LIMIT 1""").fetchone()
            if row is None:
                return None
            db.execute("UPDATE jobs SET status='running',started_at=? WHERE id=?", (now, row["id"]))
            db.execute("UPDATE users SET last_scheduled=? WHERE id=?", (now, row["owner_id"]))
            db.execute("UPDATE scheduler SET next_dispatch_at=? WHERE id=1", (now + self.settings.generation_interval,))
            return dict(row)

    def _safe_error(self, message):
        value = str(message)
        for secret in (self.settings.nai_token, self.settings.access_token, self.settings.admin_token):
            if secret:
                value = value.replace(secret, "[redacted]")
        value = re.sub(r"(?i)(bearer\s+|pst-)[A-Za-z0-9._~+/=-]+", "[redacted]", value)
        value = re.sub(r"[A-Za-z0-9+/=]{100,}", "[redacted data]", value)
        return value[:250]

    def _finish_error(self, job_id, uncertain, message, retry_after=None):
        now = time.time()
        with self.store.transaction() as db:
            row = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
            if row["status"] not in {"running", "unknown"}:
                return
            db.execute("UPDATE jobs SET status=?,error=?,completed_at=?,expires_at=?,storage_reserve=0 WHERE id=?",
                       ("unknown" if uncertain else "failed", self._safe_error(message), now,
                        now + row["retention_hours"] * 3600, job_id))
            if not uncertain:
                self._settle(db, row, False)
            if retry_after:
                db.execute("UPDATE scheduler SET cooldown_until=MAX(cooldown_until,?) WHERE id=1",
                           (now + min(max(float(retry_after), 0), 86400),))

    @staticmethod
    def _atomic_file(path, data):
        temporary = path.with_suffix(path.suffix + ".part")
        with temporary.open("wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        if os.name != "nt":
            descriptor = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)

    def _write_artifacts(self, row, artifacts):
        if not isinstance(artifacts, (list, tuple)) or not artifacts or len(artifacts) > 16:
            raise RuntimeError("Upstream did not provide a complete final result")
        total = sum(len(a.data) for a in artifacts if isinstance(a.data, bytes))
        with self.store.lock:
            current = self._storage_usage(self.store.connection)
            cap = self.store.policy()["max_storage_mb"] * 1024 * 1024
            if current - row["storage_reserve"] + total > cap:
                raise RuntimeError("Complete upstream result exceeds the reserved temporary capacity")
        records, created_paths = [], []
        manifest_path = self.staging / f"{row['id']}.json"
        try:
            for index, artifact in enumerate(artifacts):
                if not isinstance(artifact.data, bytes) or not artifact.data:
                    raise RuntimeError("Empty final artifact")
                if artifact.media_type not in {"image/png", "image/jpeg", "image/webp", "application/json"}:
                    raise RuntimeError("Unexpected artifact media type")
                if not isinstance(artifact.metadata, dict) or len(compact(artifact.metadata).encode()) > 65536:
                    raise RuntimeError("Unexpected artifact metadata")
                if artifact.media_type == "application/json":
                    json.loads(artifact.data)
                else:
                    from PIL import Image
                    from io import BytesIO
                    with Image.open(BytesIO(artifact.data)) as picture:
                        if picture.width * picture.height > 64_000_000:
                            raise RuntimeError("Result dimensions exceed the storage boundary")
                        picture.verify()
                result_id = str(uuid.uuid4())
                relative = f"results/{result_id}.bin"
                path = self._path(relative)
                created_paths.append(path)
                self._atomic_file(path, artifact.data)
                extension = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "application/json": "json"}[artifact.media_type]
                records.append({"id": result_id, "job_id": row["id"], "owner_id": row["owner_id"], "path": relative,
                                "media_type": artifact.media_type, "filename": f"result-{index + 1}.{extension}",
                                "sha256": hashlib.sha256(artifact.data).hexdigest(), "size": len(artifact.data),
                                "metadata": artifact.metadata})
            # Only this complete manifest is adoptable after a crash. Partial files never become results.
            now = time.time()
            manifest = {"job_id": row["id"], "owner_id": row["owner_id"], "completed_at": now,
                        "expires_at": now + row["retention_hours"] * 3600, "results": records}
            self._atomic_file(manifest_path, compact(manifest).encode())
            return manifest
        except BaseException:
            # A write failure cannot leave unindexed private inputs/results indefinitely.
            if not manifest_path.exists():
                for path in created_paths + [manifest_path]:
                    for candidate in (path, path.with_suffix(path.suffix + ".part")):
                        try:
                            candidate.unlink(missing_ok=True)
                        except OSError:
                            pass  # Startup reconciliation retries under the exclusive process lock.
            raise

    def _complete(self, manifest):
        if not isinstance(manifest.get("results"), list) or not manifest["results"]:
            raise RuntimeError("No complete artifacts in recovery manifest")
        with self.store.transaction() as db:
            row = db.execute("SELECT * FROM jobs WHERE id=?", (manifest["job_id"],)).fetchone()
            if not row or row["owner_id"] != manifest["owner_id"]:
                raise RuntimeError("Completion owner mismatch")
            if row["status"] == "succeeded":
                return
            if row["status"] not in {"running", "unknown"}:
                raise RuntimeError("Job no longer accepts a completion")
            for result in manifest["results"]:
                data = self._path(result["path"]).read_bytes()
                if len(data) != result["size"] or hashlib.sha256(data).hexdigest() != result["sha256"]:
                    raise RuntimeError("Final result integrity failure")
                db.execute("""INSERT INTO results(id,job_id,owner_id,path,media_type,filename,sha256,size,expires_at,metadata)
                    VALUES(?,?,?,?,?,?,?,?,?,?)""", (result["id"], row["id"], row["owner_id"], result["path"],
                    result["media_type"], result["filename"], result["sha256"], result["size"], manifest["expires_at"],
                    compact(result["metadata"])))
            db.execute("UPDATE jobs SET status='succeeded',completed_at=?,expires_at=?,error=NULL,storage_reserve=0 WHERE id=?",
                       (manifest["completed_at"], manifest["expires_at"], row["id"]))
            self._settle(db, row, True)

    def recover(self):
        # Called before workers start, under the exclusive data-directory process lock.
        for manifest_path in self.staging.glob("*.json"):
            try:
                manifest = json.loads(manifest_path.read_text("utf-8"))
                self._complete(manifest)
                manifest_path.unlink()
            except (OSError, ValueError, KeyError, RuntimeError):
                # No complete verified manifest: never infer that the upstream did not execute.
                continue
        now = time.time()
        with self.store.transaction() as db:
            db.execute("""UPDATE jobs SET status='unknown',completed_at=?,expires_at=?+retention_hours*3600,
                error='服务中断后无法确认上游结果，已保留预占额度；不会自动重试',storage_reserve=0
                WHERE status='running'""", (now, now))
            for result in db.execute("SELECT * FROM results WHERE deleted=0").fetchall():
                path = self._path(result["path"])
                try:
                    valid = path.is_file() and path.stat().st_size == result["size"] and hashlib.sha256(path.read_bytes()).hexdigest() == result["sha256"]
                except OSError:
                    valid = False
                if not valid:
                    db.execute("UPDATE results SET deleted=1,metadata='{}' WHERE id=?", (result["id"],))
                    db.execute("UPDATE jobs SET status='unknown',error='已登记结果缺失或损坏，需人工核对；不会自动重试' WHERE id=?",
                               (result["job_id"],))
        # Drop unregistered partial results. Their jobs remain unknown, never queued again.
        registered = {row["path"] for row in self.store.all("SELECT path FROM results")}
        for path in self.files.iterdir():
            if path.is_file() and path.relative_to(self.settings.data_dir).as_posix() not in registered:
                path.unlink(missing_ok=True)
        for path in self.staging.iterdir():
            if path.is_file():
                path.unlink(missing_ok=True)
        self._cleanup(now)

    def _cleanup(self, now):
        with self.store.transaction() as db:
            db.execute("UPDATE results SET deleted=1,metadata='{}' WHERE deleted=0 AND expires_at<=?", (now,))
            expired = db.execute("SELECT id FROM jobs WHERE expires_at<=? AND status IN ('succeeded','failed','cancelled','unknown')", (now,)).fetchall()
            for row in expired:
                db.execute("UPDATE results SET deleted=1,metadata='{}' WHERE job_id=?", (row["id"],))
                self._clear_finished_content(db, row["id"])
                db.execute("UPDATE jobs SET error=CASE WHEN error IS NULL THEN NULL ELSE '任务内容已到期清理' END WHERE id=?", (row["id"],))
        for row in self.store.all("SELECT * FROM results WHERE deleted=1"):
            self._remove_file(row, strict=False)
        # Incomplete files have no public index. Clean them after the same bounded retention,
        # without touching inputs of queued/running tasks or adopting an uncertain execution.
        registered = {row["path"] for row in self.store.all("SELECT path FROM results")}
        cutoff = now - self.store.policy()["retention_hours"] * 3600
        for directory in (self.files, self.staging):
            for path in directory.iterdir():
                try:
                    relative = path.relative_to(self.settings.data_dir).as_posix()
                    if path.is_file() and relative not in registered and path.stat().st_mtime <= cutoff:
                        path.unlink(missing_ok=True)
                except OSError:
                    pass
        if expired:
            self.store.checkpoint()

    async def cleanup_once(self, now=None):
        self._cleanup(time.time() if now is None else now)

    async def _run(self, row):
        job_id = row["id"]
        async def preview(payload):
            if not isinstance(payload, dict):
                return
            image = payload.get("image", "")
            if isinstance(image, str) and len(image) <= 8 * 1024 * 1024 and payload.get("media_type") in {"image/jpeg", "image/png"}:
                self.previews[job_id] = {key: payload[key] for key in ("image", "media_type", "step") if key in payload}
        try:
            job = self.job(row["owner_id"], job_id)
            artifacts = await asyncio.wait_for(self.adapter.execute(job, on_preview=preview), timeout=self.settings.upstream_timeout)
            manifest = self._write_artifacts(row, artifacts)
            self._complete(manifest)
            (self.staging / f"{job_id}.json").unlink(missing_ok=True)
        except asyncio.CancelledError:
            self._finish_error(job_id, True, "执行中服务停止，结果未知；预占额度已保留，不会自动重试")
            raise
        except Exception as exc:
            # Only the adapter's explicit, bounded failure class may release a reservation.
            from .adapters import AdapterError
            uncertain = not isinstance(exc, AdapterError) or bool(exc.uncertain)
            if isinstance(exc, AdapterError):
                message = exc.message
                retry_after = exc.retry_after
            else:
                message = "执行或保存未能确认完成，预占额度已保留；请核对后处理"
                retry_after = None
            self._finish_error(job_id, uncertain, message, retry_after)
        finally:
            self.previews.pop(job_id, None)

    async def _worker(self):
        while not self.stopping:
            self.wake.clear()
            row = self._claim()
            if row:
                await self._run(row)
                continue
            try:
                await asyncio.wait_for(self.wake.wait(), timeout=0.1)
            except asyncio.TimeoutError:
                pass

    async def _cleaner(self):
        while not self.stopping:
            await asyncio.sleep(self.settings.cleanup_interval)
            await self.cleanup_once()

    async def _guard(self, operation):
        try:
            await operation()
        except asyncio.CancelledError:
            raise
        except Exception:
            # Fail closed if persistence/scheduling itself breaks; never silently strand a dead worker.
            self.degraded_error = "后台持久化或任务调度异常，请检查数据目录并重启恢复"

    async def start(self):
        self.tasks = [asyncio.create_task(self._guard(self._worker), name=f"queue-worker-{i}")
                      for i in range(self.settings.global_concurrency)]
        self.tasks.append(asyncio.create_task(self._guard(self._cleaner), name="result-cleaner"))

    async def close(self):
        self.stopping = True
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        try:
            await self.adapter.close()
        finally:
            self.store.close()
