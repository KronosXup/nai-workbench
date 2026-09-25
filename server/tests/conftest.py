"""Integration helpers: real app/storage, controlled in-process upstream only."""

from __future__ import annotations

import asyncio
import base64
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
import sys
import threading
import time
from typing import Any
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.adapters import Artifact  # noqa: E402
from app.config import Settings  # noqa: E402


USER_TOKEN = "test-user-access-not-a-real-secret"
ADMIN_TOKEN = "test-admin-access-not-a-real-secret"
USER_HEADERS = {"Authorization": f"Bearer {USER_TOKEN}"}
ADMIN_HEADERS = {"Authorization": f"Bearer {ADMIN_TOKEN}"}
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYGAAAAAEAAH2"
    "FzhVAAAAAElFTkSuQmCC"
)


class ControlledAdapter:
    """Uses a gate to hold real workers between reservation and settlement."""

    def __init__(self, *, blocked: bool = False, data: bytes = PNG, error=None):
        self.data = data
        self.error = error
        self.calls: list[dict[str, Any]] = []
        self.started = threading.Event()
        self.gate = threading.Event()
        if not blocked:
            self.gate.set()

    async def execute(self, job: dict, on_preview=None):
        self.calls.append(job)
        self.started.set()
        while not self.gate.is_set():
            await asyncio.sleep(0.01)
        if self.error is not None:
            raise self.error
        return [Artifact(data=self.data, media_type="image/png", filename="fixture.png")]

    async def close(self):
        pass


def task_payload(**overrides) -> dict:
    payload = {
        "request_id": str(uuid4()),
        "operation": "generate",
        "model": "nai-diffusion-4-5-full",
        "prompt": "private test drawing",
        "negative_prompt": "private test negative",
        "parameters": {
            "width": 512,
            "height": 512,
            "steps": 28,
            "scale": 5,
            "seed": 123456,
            "sampler": "k_euler_ancestral",
            "n_samples": 1,
        },
    }
    payload.update(overrides)
    return payload


def successful(response):
    assert 200 <= response.status_code < 300, (response.status_code, response.text)
    return response.json()


def submit(client, payload=None, *, headers=USER_HEADERS):
    return successful(client.post("/api/jobs", json=payload or task_payload(), headers=headers))


def wait_job(client, job_id, status="succeeded", *, headers=USER_HEADERS, timeout=5):
    deadline = time.monotonic() + timeout
    current = None
    while time.monotonic() < deadline:
        current = successful(client.get(f"/api/jobs/{job_id}", headers=headers))
        if current["status"] == status:
            return current
        if current["status"] in {"failed", "cancelled", "unknown"} and status != current["status"]:
            pytest.fail(f"Expected {status}, received terminal job {current}")
        time.sleep(0.01)
    pytest.fail(f"Job did not reach {status}: {current}")


def quota(client, headers=USER_HEADERS):
    return successful(client.get("/api/me", headers=headers))["quota"]


@dataclass
class Harness:
    client: TestClient
    app: Any
    settings: Settings
    adapter: ControlledAdapter


@pytest.fixture
def app_factory(tmp_path):
    # The public Gate runtime intentionally omits app.main. Import the legacy
    # app only when a legacy fixture is actually requested by a local test.
    from app.main import create_app

    @contextmanager
    def start(*, adapter=None, data_dir=None, **overrides):
        config = {
            "data_dir": data_dir or tmp_path / str(uuid4()),
            "access_token": USER_TOKEN,
            "admin_token": ADMIN_TOKEN,
            "upstream_mode": "mock",
            "generation_interval": 0,
            "mock_delay": 0,
        }
        config.update(overrides)
        settings = Settings(**config)
        upstream = adapter or ControlledAdapter()
        app = create_app(settings, adapter=upstream)
        with TestClient(app) as client:
            yield Harness(client, app, settings, upstream)

    return start
