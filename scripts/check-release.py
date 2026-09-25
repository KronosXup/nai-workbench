#!/usr/bin/env python3
"""Build and run the offline checks included in the public source package."""

from __future__ import annotations

import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[1]
PUBLIC_TESTS = (
    "server/tests/test_gate_bridge.py",
    "server/tests/test_inpaint.py",
    "server/tests/test_bridge_security.py",
    "server/adapter_tests/test_adapters.py",
)
CLIENT_TESTS = (
    "client/scripts/test-canvas-tools.mjs",
    "client/scripts/test-canvas-storage.mjs",
    "client/scripts/test-canvas-project.mjs",
    "client/scripts/test-pixel-snap.mjs",
)

PYTHON_OFFLINE_GUARD = r'''
import ipaddress
import socket

_getaddrinfo = socket.getaddrinfo
_connect = socket.socket.connect
_connect_ex = socket.socket.connect_ex
_sendto = socket.socket.sendto
_AF_UNIX = getattr(socket, "AF_UNIX", None)

def _is_unix_socket(sock):
    return _AF_UNIX is not None and sock.family == _AF_UNIX

def _host_text(host):
    if isinstance(host, bytes):
        host = host.decode("ascii", errors="ignore")
    return host.strip("[]") if isinstance(host, str) else host

def _is_loopback(host):
    host = _host_text(host)
    if isinstance(host, str) and host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except (TypeError, ValueError):
        return False

def _guarded_getaddrinfo(host, *args, **kwargs):
    host_text = _host_text(host)
    if host_text in {"0.0.0.0", "::"}:
        return _getaddrinfo(host, *args, **kwargs)
    if not _is_loopback(host):
        raise OSError(f"offline release checks blocked DNS for {host!r}")
    return _getaddrinfo(host, *args, **kwargs)

def _guarded_connect(self, address):
    if _is_unix_socket(self):
        return _connect(self, address)
    host = address[0] if isinstance(address, tuple) and address else None
    if not _is_loopback(host):
        raise OSError(f"offline release checks blocked network connection to {host!r}")
    return _connect(self, address)

def _guarded_connect_ex(self, address):
    if _is_unix_socket(self):
        return _connect_ex(self, address)
    host = address[0] if isinstance(address, tuple) and address else None
    if not _is_loopback(host):
        raise OSError(f"offline release checks blocked network connection to {host!r}")
    return _connect_ex(self, address)

def _guarded_sendto(self, data, *args):
    if _is_unix_socket(self):
        return _sendto(self, data, *args)
    address = args[-1] if args else None
    host = address[0] if isinstance(address, tuple) and address else None
    if not _is_loopback(host):
        raise OSError(f"offline release checks blocked datagram to {host!r}")
    return _sendto(self, data, *args)

socket.getaddrinfo = _guarded_getaddrinfo
socket.socket.connect = _guarded_connect
socket.socket.connect_ex = _guarded_connect_ex
socket.socket.sendto = _guarded_sendto
'''

NODE_OFFLINE_GUARD = r'''
const net = require('node:net');
const originalConnect = net.Socket.prototype.connect;

function loopback(host) {
  if (typeof host !== 'string') return false;
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

net.Socket.prototype.connect = function (...args) {
  const first = args[0];
  let host = null;
  if (first && typeof first === 'object') {
    if (first.path) return originalConnect.apply(this, args);
    host = first.host ?? first.hostname ?? 'localhost';
  } else if (typeof first === 'number') {
    host = typeof args[1] === 'string' ? args[1] : 'localhost';
  } else if (typeof first === 'string') {
    // A string-only argument is a local Unix-domain socket path.
    return originalConnect.apply(this, args);
  }
  if (!loopback(host)) {
    throw new Error(`offline release checks blocked network connection to ${String(host)}`);
  }
  return originalConnect.apply(this, args);
};

if (typeof globalThis.fetch === 'function') {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, ...args) => {
    const target = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url;
    const url = new URL(target);
    if (!loopback(url.hostname)) {
      return Promise.reject(new Error(`offline release checks blocked fetch to ${url.hostname}`));
    }
    return originalFetch(input, ...args);
  };
}
'''


def run(name: str, command: list[str], *, cwd: Path, env: dict[str, str]) -> None:
    print(f"\n== {name} ==", flush=True)
    if os.name == "nt" and Path(command[0]).suffix.lower() in {".bat", ".cmd"}:
        # Windows batch shims such as npm.cmd must be launched through cmd.exe.
        result = subprocess.run(subprocess.list2cmdline(command), cwd=cwd, env=env, shell=True, check=False)
    else:
        result = subprocess.run(command, cwd=cwd, env=env, check=False)
    if result.returncode:
        raise SystemExit(result.returncode)


def require_supported_node(node: str) -> None:
    result = subprocess.run([node, "--version"], capture_output=True, text=True, check=False)
    version_text = result.stdout.strip()
    try:
        parts = version_text.removeprefix("v").split(".")
        version = (int(parts[0]), int(parts[1]))
    except (IndexError, ValueError):
        raise SystemExit(f"Could not read the Node.js version from {version_text!r}.") from None
    if result.returncode or version < (22, 18):
        raise SystemExit(f"Node.js 22.18 or newer is required for direct TypeScript imports; found {version_text}.")


def main() -> int:
    missing = [name for name in (*PUBLIC_TESTS, *CLIENT_TESTS) if not (ROOT / name).is_file()]
    if missing:
        raise SystemExit("Public release check is missing required files: " + ", ".join(missing))

    node = shutil.which("node")
    npm = (shutil.which("npm.cmd") or shutil.which("npm")) if os.name == "nt" else shutil.which("npm")
    if not node or not npm:
        raise SystemExit("Node.js 22.18+ and npm are required. Install client dependencies with `npm ci --prefix client` first.")
    require_supported_node(node)

    checks = [
        *sorted((ROOT / "scripts").glob("check-*.mjs")),
        *(ROOT / name for name in CLIENT_TESTS),
    ]
    if not checks:
        raise SystemExit("No scripts/check-*.mjs client checks were found.")

    with tempfile.TemporaryDirectory(prefix="nai-workbench-offline-") as temporary:
        guard_dir = Path(temporary)
        (guard_dir / "sitecustomize.py").write_text(PYTHON_OFFLINE_GUARD, encoding="utf-8")
        node_guard = guard_dir / "offline-network-guard.cjs"
        node_guard.write_text(NODE_OFFLINE_GUARD, encoding="utf-8")

        env = os.environ.copy()
        env["WORKBENCH_UPSTREAM_MODE"] = "mock"
        env["WORKBENCH_GATE_URL"] = "http://127.0.0.1:9"
        env["PYTEST_DISABLE_PLUGIN_AUTOLOAD"] = "1"
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        env["PYTHONPATH"] = os.pathsep.join(
            item for item in (str(guard_dir), str(ROOT / "server"), env.get("PYTHONPATH", "")) if item
        )
        env["NODE_OPTIONS"] = f"--require={node_guard.as_posix()}"
        env["HTTP_PROXY"] = env["HTTPS_PROXY"] = env["ALL_PROXY"] = "http://127.0.0.1:9"
        env["NO_PROXY"] = "localhost,127.0.0.1,::1"
        env["http_proxy"] = env["https_proxy"] = env["all_proxy"] = "http://127.0.0.1:9"
        env["no_proxy"] = env["NO_PROXY"]

        run("frontend production build", [npm, "run", "build"], cwd=ROOT / "client", env=env)
        run(
            "public Gate and adapter tests (mock upstream, external sockets blocked)",
            [sys.executable, "-m", "pytest", "-q", *PUBLIC_TESTS],
            cwd=ROOT,
            env=env,
        )
        for script in checks:
            run(script.relative_to(ROOT).as_posix(), [node, str(script)], cwd=ROOT, env=env)

    print(f"\nPASS: offline release checks completed ({len(checks)} client scripts).", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
