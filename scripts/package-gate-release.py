#!/usr/bin/env python3
"""Package the public Gate workbench source and its SHA-256 manifest."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import shutil
import tarfile
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]

FIXED_FILES = (
    ".dockerignore",
    ".env.gate.example",
    ".gitignore",
    ".gitattributes",
    ".github/workflows/check.yml",
    "Dockerfile.gate",
    "Dockerfile.gate.dockerignore",
    "README.md",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "client/README.md",
    "client/index.html",
    "client/package-lock.json",
    "client/package.json",
    "client/tsconfig.json",
    "client/vite.config.ts",
    "client/scripts/test-canvas-project.mjs",
    "client/scripts/test-canvas-storage.mjs",
    "client/scripts/test-canvas-tools.mjs",
    "client/scripts/test-pixel-snap.mjs",
    "client/public/fonts/SourceSansPro-Bold.ttf.woff2",
    "client/public/fonts/SourceSansPro-LICENSE.txt",
    "client/public/fonts/SourceSansPro-Regular.ttf.woff2",
    "client/public/fonts/SourceSansPro-Semibold.ttf.woff2",
    "client/public/textures/login-print-texture.svg",
    "client/public/tokenizers/LICENSE-APACHE-2.0.txt",
    "client/public/tokenizers/LICENSE-CLIP-MIT.txt",
    "client/public/tokenizers/NOTICE.txt",
    "client/public/tokenizers/clip.json",
    "client/public/tokenizers/qwen.json",
    "client/public/tokenizers/t5.json",
    "compose.gate.yaml",
    "docs/GATE-FRONTEND.md",
    "docs/GATE-COMPATIBILITY.md",
    "docs/DEVELOPMENT.md",
    "pytest.ini",
    "scripts/package-gate-release.py",
    "scripts/generate-third-party-notices.py",
    "scripts/check-release.py",
    "scripts/check-backup-validation.mjs",
    "scripts/check-client-lifecycle.mjs",
    "scripts/check-connection.mjs",
    "scripts/check-gate-client.mjs",
    "scripts/check-image-import.mjs",
    "scripts/check-image-tokenizer.mjs",
    "scripts/check-vibe-files.mjs",
    "server/requirements.lock.txt",
    "server/app/__init__.py",
    "server/app/adapters.py",
    "server/app/config.py",
    "server/app/gate_bridge.py",
    "server/app/inpaint.py",
    "server/app/model_policy.py",
    "server/app/task_validation.py",
    "server/tests/conftest.py",
    "server/tests/test_bridge_security.py",
    "server/tests/test_gate_bridge.py",
    "server/tests/test_inpaint.py",
    "server/tests/test_task_validation.py",
    "server/adapter_tests/test_adapters.py",
)
CLIENT_SOURCE_SUFFIXES = {".css", ".ts", ".tsx"}


def allowlisted_files() -> list[str]:
    files = set(FIXED_FILES)
    licenses_root = ROOT / "third_party_licenses"
    license_index = licenses_root / ".generated-files.json"
    files.add(license_index.relative_to(ROOT).as_posix())
    for name in json.loads(license_index.read_text(encoding="utf-8"))["files"]:
        path = Path(name)
        if path.is_absolute() or ".." in path.parts or path.parts[:1] != ("third_party_licenses",):
            raise ValueError(f"Invalid license path in generated index: {name}")
        files.add(path.as_posix())
    source_root = ROOT / "client" / "src"
    if not source_root.is_dir():
        raise FileNotFoundError(f"Required client source directory is missing: {source_root}")
    for path in source_root.rglob("*"):
        if path.is_symlink():
            raise ValueError(f"Symlinks are not allowed in the release context: {path}")
        if path.is_file() and path.suffix.lower() in CLIENT_SOURCE_SUFFIXES:
            files.add(path.relative_to(ROOT).as_posix())
    return sorted(files)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def default_output_dir() -> Path:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    return ROOT / "artifacts" / f"gate-build-context-{stamp}"


def create_tar(context: Path, names: list[str], archive_path: Path) -> None:
    # Add only regular file entries; tar extraction creates parent directories.
    with tarfile.open(archive_path, mode="w:gz", compresslevel=9) as archive:
        for name in names:
            path = context / Path(*name.split("/"))
            data = path.read_bytes()
            info = tarfile.TarInfo(name=name)
            info.type = tarfile.REGTYPE
            info.size = len(data)
            info.mode = 0o644
            info.mtime = 0
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            archive.addfile(info, io.BytesIO(data))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output-dir",
        type=Path,
        help="new output directory (default: a timestamped directory under artifacts/)",
    )
    args = parser.parse_args()

    output_dir = args.output_dir or default_output_dir()
    if not output_dir.is_absolute():
        output_dir = ROOT / output_dir
    output_dir = output_dir.resolve()
    if output_dir.exists():
        raise FileExistsError(f"Output directory already exists; choose a new path: {output_dir}")

    names = allowlisted_files()
    for name in names:
        source = ROOT / Path(*name.split("/"))
        if source.is_symlink() or not source.is_file():
            raise FileNotFoundError(f"Required regular source file is missing: {source}")

    output_dir.mkdir(parents=True)
    context = output_dir / "context"
    context.mkdir(mode=0o755)
    try:
        directory_names: set[str] = set()
        for name in names:
            source = ROOT / Path(*name.split("/"))
            target = context / Path(*name.split("/"))
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
            os.chmod(target, 0o644)
            parent = Path(name).parent
            while parent != Path("."):
                directory_names.add(parent.as_posix())
                parent = parent.parent

        for name in sorted(directory_names, key=lambda value: (value.count("/"), value)):
            os.chmod(context / Path(*name.split("/")), 0o755)
        os.chmod(context, 0o755)

        manifest = {
            "schema_version": 1,
            "algorithm": "sha256",
            "files": {name: sha256(context / Path(*name.split("/"))) for name in names},
            "directories": {name: "0755" for name in sorted(directory_names)},
        }
        archive_path = output_dir / "context.tar.gz"
        create_tar(context, names, archive_path)
        manifest["archive"] = {
            "path": archive_path.name,
            "sha256": sha256(archive_path),
        }
        manifest_path = output_dir / "manifest.json"
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    except Exception:
        # Leave partial output visible for diagnosis; never remove user files implicitly.
        raise

    print(json.dumps({
        "output_dir": str(output_dir),
        "context_dir": str(context),
        "archive": str(archive_path),
        "manifest": str(manifest_path),
        "file_count": len(names),
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
