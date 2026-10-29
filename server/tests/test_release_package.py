"""The published source archive must remain independently buildable/testable."""
from pathlib import Path
import runpy
import shlex

ROOT = Path(__file__).resolve().parents[2]


def release_files():
    return set(runpy.run_path(str(ROOT / "scripts/package-gate-release.py"))["allowlisted_files"]())


def test_release_contains_docker_runtime_sources():
    names = release_files()
    required = set()
    for line in (ROOT / "Dockerfile.gate").read_text().splitlines():
        if not line.startswith("COPY "):
            continue
        words = shlex.split(line)
        if not words[1].startswith("--"):
            required.update(word for word in words[1:-1] if word.startswith("server/") and word.endswith(".py"))
    assert required
    assert required <= names, f"Missing Docker runtime imports: {required - names}"


def test_release_includes_auth_docs_and_tests():
    names = release_files()
    checks = runpy.run_path(str(ROOT / "scripts/check-release.py"))
    client_tests = {p.relative_to(ROOT).as_posix() for p in (ROOT / "client/scripts").glob("test-*.mjs")}
    server_tests = {"server/tests/test_workbench_session.py", "server/tests/test_release_package.py"}
    assert client_tests <= set(checks["CLIENT_TESTS"])
    assert server_tests <= set(checks["PUBLIC_TESTS"])
    assert client_tests | server_tests | {"client/DISCORD_AUTH.md"} <= names
