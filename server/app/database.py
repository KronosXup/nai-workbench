from __future__ import annotations

import contextlib
import hashlib
import json
import os
import secrets
import sqlite3
import threading
import time
import uuid
from pathlib import Path

from .config import Settings


SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, slot TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0, token_hash TEXT UNIQUE NOT NULL, source_hash TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1, quota_limit REAL NOT NULL,
    quota_used REAL NOT NULL DEFAULT 0, quota_reserved REAL NOT NULL DEFAULT 0,
    last_scheduled REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS scheduler (
    id INTEGER PRIMARY KEY CHECK(id=1), next_dispatch_at REAL NOT NULL DEFAULT 0,
    cooldown_until REAL NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO scheduler(id) VALUES(1);
CREATE TABLE IF NOT EXISTS jobs (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
    owner_id TEXT NOT NULL REFERENCES users(id), request_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL, operation TEXT NOT NULL, model TEXT NOT NULL,
    prompt TEXT NOT NULL, negative_prompt TEXT NOT NULL, parameters TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
    created_at REAL NOT NULL, started_at REAL, completed_at REAL, expires_at REAL,
    error TEXT, quota_units REAL NOT NULL, quota_state TEXT NOT NULL DEFAULT 'reserved',
    storage_mode TEXT NOT NULL, retention_hours REAL NOT NULL,
    input_bytes INTEGER NOT NULL DEFAULT 0, storage_reserve INTEGER NOT NULL DEFAULT 0,
    UNIQUE(owner_id,request_id)
);
CREATE INDEX IF NOT EXISTS jobs_owner_status ON jobs(owner_id,status,seq);
CREATE TABLE IF NOT EXISTS results (
    id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id),
    owner_id TEXT NOT NULL REFERENCES users(id), path TEXT NOT NULL,
    media_type TEXT NOT NULL, filename TEXT NOT NULL, sha256 TEXT NOT NULL,
    size INTEGER NOT NULL, expires_at REAL NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
    acknowledged INTEGER NOT NULL DEFAULT 0, metadata TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS results_job ON results(job_id);
CREATE INDEX IF NOT EXISTS results_expiry ON results(deleted,expires_at);
CREATE TABLE IF NOT EXISTS batches (
    owner_id TEXT NOT NULL REFERENCES users(id), request_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL, job_ids TEXT NOT NULL, PRIMARY KEY(owner_id,request_id)
);
CREATE TABLE IF NOT EXISTS quota_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES jobs(id),
    owner_id TEXT NOT NULL REFERENCES users(id), event TEXT NOT NULL, units REAL NOT NULL,
    created_at REAL NOT NULL, UNIQUE(job_id,event)
);
CREATE TABLE IF NOT EXISTS resolutions (
    job_id TEXT PRIMARY KEY REFERENCES jobs(id), actor_id TEXT NOT NULL REFERENCES users(id),
    decision TEXT NOT NULL, reason TEXT NOT NULL, created_at REAL NOT NULL
);
"""


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def compact(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


class DataDirectoryLock:
    """One scheduler per SQLite data directory, including across OS processes."""

    def __init__(self, path: Path):
        self.handle = path.open("a+b")
        self.handle.seek(0)
        if not self.handle.read(1):
            self.handle.write(b"0")
            self.handle.flush()
        self.handle.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(self.handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (OSError, IOError) as exc:
            self.handle.close()
            raise RuntimeError("Data directory is already used by a workbench process") from exc

    def close(self):
        if self.handle.closed:
            return
        self.handle.seek(0)
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(self.handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(self.handle.fileno(), fcntl.LOCK_UN)
        self.handle.close()


class Store:
    def __init__(self, settings: Settings):
        self.settings = settings
        settings.data_dir.mkdir(parents=True, exist_ok=True)
        if os.name != "nt":
            settings.data_dir.chmod(0o700)
        self.directory_lock = DataDirectoryLock(settings.data_dir / "scheduler.lock")
        self.path = settings.data_dir / "workbench.sqlite3"
        self.lock = threading.RLock()
        self.connection = sqlite3.connect(self.path, isolation_level=None, check_same_thread=False)
        self.connection.row_factory = sqlite3.Row
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.execute("PRAGMA synchronous=FULL")
        self.connection.execute("PRAGMA foreign_keys=ON")
        self.connection.execute("PRAGMA secure_delete=ON")
        self.connection.execute("PRAGMA busy_timeout=5000")
        self.connection.executescript(SCHEMA)
        if "source_hash" not in {row[1] for row in self.connection.execute("PRAGMA table_info(users)")}:
            self.connection.execute("ALTER TABLE users ADD COLUMN source_hash TEXT NOT NULL DEFAULT ''")
        self._bootstrap()

    @contextlib.contextmanager
    def transaction(self):
        with self.lock:
            self.connection.execute("BEGIN IMMEDIATE")
            try:
                yield self.connection
            except BaseException:
                self.connection.rollback()
                raise
            else:
                self.connection.commit()

    def one(self, sql, args=()):
        with self.lock:
            return self.connection.execute(sql, args).fetchone()

    def all(self, sql, args=()):
        with self.lock:
            return self.connection.execute(sql, args).fetchall()

    def _bootstrap(self):
        settings = self.settings
        bootstrap_path = settings.data_dir / "bootstrap.json"
        saved = {}
        if bootstrap_path.exists():
            saved = json.loads(bootstrap_path.read_text("utf-8"))
        values = {
            "access_token": settings.access_token or saved.get("access_token") or secrets.token_urlsafe(32),
            "admin_token": settings.admin_token or saved.get("admin_token") or secrets.token_urlsafe(32),
        }
        if values["access_token"] == values["admin_token"]:
            raise ValueError("User and admin credentials must be different")
        if not settings.access_token or not settings.admin_token:
            temporary = bootstrap_path.with_suffix(".tmp")
            descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                handle.write(compact(values))
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, bootstrap_path)
            if os.name != "nt":
                bootstrap_path.chmod(0o600)
        with self.transaction() as db:
            for slot, name, admin, token in (
                ("local_user", "绘图用户", 0, values["access_token"]),
                ("local_admin", "管理员", 1, values["admin_token"]),
            ):
                existing = db.execute("SELECT id,source_hash FROM users WHERE slot=?", (slot,)).fetchone()
                if existing:
                    # An unchanged bootstrap value must not resurrect a credential rotated via the admin API.
                    if existing["source_hash"] != token_hash(token):
                        db.execute("UPDATE users SET token_hash=?,source_hash=? WHERE id=?",
                                   (token_hash(token), token_hash(token), existing["id"]))
                else:
                    db.execute(
                        "INSERT INTO users(id,slot,name,is_admin,token_hash,source_hash,quota_limit) VALUES(?,?,?,?,?,?,?)",
                        (str(uuid.uuid4()), slot, name, admin, token_hash(token), token_hash(token), settings.user_quota),
                    )
            db.execute("INSERT OR IGNORE INTO settings VALUES(1,?)", (compact({
                "mode": settings.storage_mode, "retention_hours": settings.retention_hours,
                "max_pending_per_user": settings.max_pending_per_user, "max_storage_mb": settings.max_storage_mb,
            }),))

    def authenticate(self, token):
        if not token or len(token) > 1024:
            return None
        return self.one("SELECT * FROM users WHERE token_hash=? AND enabled=1", (token_hash(token),))

    def policy(self):
        return json.loads(self.one("SELECT value FROM settings WHERE id=1")["value"])

    def checkpoint(self):
        # secure_delete erases freed DB cells; truncate committed WAL frames containing old snapshots.
        with self.lock:
            self.connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")

    def close(self):
        try:
            with self.lock:
                self.connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                self.connection.close()
        finally:
            self.directory_lock.close()
