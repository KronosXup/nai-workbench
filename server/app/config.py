from __future__ import annotations

import os
import math
from dataclasses import dataclass, fields
from pathlib import Path


@dataclass
class Settings:
    data_dir: Path = Path(__file__).resolve().parents[1] / "data"
    upstream_mode: str = "mock"
    access_token: str = ""
    admin_token: str = ""
    nai_token: str = ""
    nai_base_url: str = "https://image.novelai.net"
    upstream_timeout: float = 180
    mock_delay: float = 0.3
    retention_hours: float = 72
    storage_mode: str = "retain_until_expiry"
    max_storage_mb: float = 512
    max_pending_per_user: int = 50
    user_quota: float = 1000
    global_concurrency: int = 1
    generation_interval: float = 0
    max_input_mb: float = 25
    cleanup_interval: float = 30

    @classmethod
    def from_env(cls) -> "Settings":
        values = {}
        defaults = cls()
        for field in fields(cls):
            raw = os.getenv("WORKBENCH_" + field.name.upper())
            if raw is None:
                continue
            default = getattr(defaults, field.name)
            if isinstance(default, Path):
                values[field.name] = Path(raw)
            elif isinstance(default, float) or field.name in {
                "upstream_timeout", "retention_hours", "max_storage_mb", "user_quota",
                "generation_interval", "max_input_mb", "cleanup_interval",
            }:
                values[field.name] = float(raw)
            elif isinstance(default, int):
                values[field.name] = int(raw)
            else:
                values[field.name] = raw
        return cls(**values)

    def validate(self) -> None:
        self.data_dir = Path(self.data_dir).resolve()
        for key in ("upstream_timeout", "mock_delay", "retention_hours", "max_storage_mb", "user_quota",
                    "generation_interval", "max_input_mb", "cleanup_interval"):
            if not math.isfinite(getattr(self, key)):
                raise ValueError(f"{key} must be finite")
        if self.upstream_mode not in {"mock", "nai"}:
            raise ValueError("upstream_mode must be mock or nai")
        if self.storage_mode not in {"retain_until_expiry", "delete_after_ack"}:
            raise ValueError("Invalid storage mode")
        if not 0 < self.retention_hours <= 24 * 365:
            raise ValueError("retention_hours must be positive and at most one year")
        if self.max_storage_mb <= 0 or self.max_pending_per_user < 1:
            raise ValueError("Storage and queue limits must be positive")
        if self.user_quota < 0 or not 1 <= self.global_concurrency <= 8:
            raise ValueError("Invalid quota or concurrency")
        if self.generation_interval < 0 or self.upstream_timeout <= 0:
            raise ValueError("Invalid upstream timing")
        if self.max_input_mb <= 0 or self.cleanup_interval <= 0:
            raise ValueError("Invalid resource limits")
        if self.access_token and self.access_token == self.admin_token:
            raise ValueError("User and admin credentials must be different")
