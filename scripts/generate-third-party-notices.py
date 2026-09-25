#!/usr/bin/env python3
"""Regenerate third-party notices from the checked-in locks and local installs."""

from __future__ import annotations

import email.parser
import ipaddress
import json
import re
import shutil
import sys
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit, urlunsplit


ROOT = Path(__file__).resolve().parents[1]
LICENSE_ROOT = ROOT / "third_party_licenses"
INDEX_PATH = LICENSE_ROOT / ".generated-files.json"
NOTICES_PATH = ROOT / "THIRD_PARTY_NOTICES.md"


def canonical_name(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def md(value: object) -> str:
    text = str(value).replace("\\", "\\\\").replace("|", "\\|")
    return text.replace("\r", " ").replace("\n", " ").strip()


def license_expression(metadata: dict) -> str:
    value = metadata.get("license")
    if isinstance(value, str) and value.strip():
        return value.strip()
    if isinstance(value, dict):
        expression = value.get("type")
        if isinstance(expression, str) and expression.strip():
            return expression.strip()
    if isinstance(value, list):
        entries = []
        for item in value:
            if isinstance(item, dict) and isinstance(item.get("type"), str):
                entries.append(item["type"].strip())
            elif isinstance(item, str):
                entries.append(item.strip())
        if entries:
            return " OR ".join(item for item in entries if item)
    return "Not declared in installed metadata; see the included license text"


def clean_public_url(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    raw = value.strip()
    if raw.startswith("git+"):
        raw = raw[4:]
    try:
        parsed = urlsplit(raw)
        host = parsed.hostname
        if parsed.scheme.lower() != "https" or not host or parsed.username or parsed.password or "." not in host:
            return None
        host = host.lower().rstrip(".")
        if host.endswith((".local", ".internal", ".lan", ".corp", ".home", ".test", ".invalid")):
            return None
        try:
            if not ipaddress.ip_address(host).is_global:
                return None
        except ValueError:
            pass
        path = parsed.path
        if path.endswith(".git"):
            path = path[:-4]
        return urlunsplit(("https", parsed.netloc, path, "", ""))
    except ValueError:
        return None


def first_public_url(values: list[tuple[str, object]]) -> str | None:
    preferred = ("source", "repository", "homepage", "home")
    for wanted in preferred:
        for label, value in values:
            if wanted in label.lower():
                cleaned = clean_public_url(value)
                if cleaned:
                    return cleaned
    for _, value in values:
        cleaned = clean_public_url(value)
        if cleaned:
            return cleaned
    return None


def relative_markdown(path: str) -> str:
    return path.replace(" ", "%20").replace("(", "%28").replace(")", "%29")


def read_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise ValueError("expected a JSON object")
    return value


def safe_target(base: str, version: str, relative: str) -> Path:
    rel = PurePosixPath(relative)
    if rel.is_absolute() or ".." in rel.parts:
        raise ValueError("unsafe license path in package metadata")
    target = LICENSE_ROOT.joinpath(*PurePosixPath(base).parts, version, *rel.parts)
    target.parent.mkdir(parents=True, exist_ok=True)
    return target


def copy_license_files(files: list[tuple[Path, str]], base: str, version: str) -> list[str]:
    copied = []
    for source, relative in files:
        target = safe_target(base, version, relative)
        if source.is_symlink():
            resolved_root = source.parent.resolve()
            try:
                source.resolve().relative_to(resolved_root)
            except ValueError:
                continue
        shutil.copyfile(source, target)
        copied.append(target.relative_to(ROOT).as_posix())
    return copied


def npm_dependency_key(packages: dict, importer: str, dependency: str) -> str | None:
    current = importer
    while current:
        candidate = f"{current}/node_modules/{dependency}"
        if candidate in packages:
            return candidate
        marker = current.rfind("/node_modules/")
        if marker < 0:
            break
        current = current[:marker]
    candidate = f"node_modules/{dependency}"
    return candidate if candidate in packages else None


def installed_npm_package(node_modules: Path, package_key: str) -> tuple[Path, dict] | None:
    if not package_key.startswith("node_modules/"):
        return None
    path = node_modules.joinpath(*PurePosixPath(package_key).parts[1:])
    manifest = path / "package.json"
    try:
        return path, read_json(manifest)
    except (OSError, ValueError, json.JSONDecodeError):
        return None


def npm_license_files(package_dir: Path) -> list[tuple[Path, str]]:
    files = []
    for path in sorted(package_dir.iterdir()):
        if not path.is_file():
            continue
        relative = path.relative_to(package_dir)
        if re.match(r"^(license|licence|copying|notice|copyright)([-_. ]|$)", path.name, re.I):
            files.append((path, relative.as_posix()))
    return files


def collect_npm(root: Path, errors: list[str], notes: list[str], generated: list[str]):
    package_json = read_json(root / "client" / "package.json")
    lock = read_json(root / "client" / "package-lock.json")
    packages = lock.get("packages")
    lock_root = packages.get("") if isinstance(packages, dict) else None
    if not isinstance(packages, dict) or not isinstance(lock_root, dict):
        raise ValueError("client/package-lock.json does not contain the expected packages map")

    declared_runtime = package_json.get("dependencies", {})
    locked_runtime = lock_root.get("dependencies", {})
    if declared_runtime != locked_runtime:
        errors.append("client/package.json runtime dependencies differ from the package-lock root entry")

    node_modules = root / "client" / "node_modules"
    direct = sorted(locked_runtime)
    queue = []
    for name in direct:
        key = npm_dependency_key(packages, "", name)
        if key:
            queue.append((key, name, True))
        else:
            errors.append(f"npm runtime dependency {name} is absent from package-lock.json")

    discovered: dict[str, dict] = {}
    while queue:
        key, name, is_direct = queue.pop()
        if key in discovered:
            continue
        installed = installed_npm_package(node_modules, key)
        lock_info = packages.get(key)
        if not installed or not isinstance(lock_info, dict):
            errors.append(f"npm package {name} is locked but not installed under client/node_modules")
            continue
        package_dir, manifest = installed
        lock_version = str(lock_info.get("version", "unknown"))
        installed_version = str(manifest.get("version", "unknown"))
        if lock_version != installed_version:
            errors.append(f"npm package {name} version mismatch: lock {lock_version}, installed {installed_version}")
        expression = license_expression(manifest)
        repository = manifest.get("repository")
        if isinstance(repository, dict):
            repository_url = repository.get("url")
            if not repository_url and repository.get("directory"):
                repository_url = None
        else:
            repository_url = repository
        source = clean_public_url(repository_url) or clean_public_url(manifest.get("homepage"))
        if source is None:
            source = clean_public_url(lock_info.get("resolved"))
        files = npm_license_files(package_dir)
        copy_paths = copy_license_files(files, f"npm/{key.removeprefix('node_modules/')}", lock_version) if files else []
        generated.extend(copy_paths)
        if not files:
            errors.append(f"npm package {name}@{lock_version} has no installed license/notice text file")
        if expression.startswith("Not declared"):
            notes.append(f"npm {name}@{lock_version}: package.json does not declare a license expression")
        discovered[key] = {
            "name": name,
            "direct": is_direct,
            "lock_version": lock_version,
            "installed_version": installed_version,
            "license": expression,
            "source": source,
            "licenses": copy_paths,
        }

        dependencies = dict(lock_info.get("dependencies", {}))
        dependencies.update(lock_info.get("optionalDependencies", {}))
        peer_names = manifest.get("peerDependencies", {})
        optional_peers = manifest.get("peerDependenciesMeta", {})
        if isinstance(peer_names, dict):
            for peer_name in peer_names:
                optional = isinstance(optional_peers, dict) and optional_peers.get(peer_name, {}).get("optional") is True
                if optional and not npm_dependency_key(packages, key, peer_name):
                    continue
                dependencies.setdefault(peer_name, "peer")
        for dependency in sorted(dependencies):
            dependency_key = npm_dependency_key(packages, key, dependency)
            if dependency_key:
                queue.append((dependency_key, dependency, False))
            elif dependency in lock_info.get("dependencies", {}):
                errors.append(f"npm runtime dependency {name} -> {dependency} is missing from the lock graph")

    dev_rows = []
    locked_dev = lock_root.get("devDependencies", {})
    declared_dev = package_json.get("devDependencies", {})
    if declared_dev != locked_dev:
        errors.append("client/package.json build dependencies differ from the package-lock root entry")
    for name in sorted(locked_dev):
        key = npm_dependency_key(packages, "", name)
        lock_info = packages.get(key) if key else None
        installed = installed_npm_package(node_modules, key) if key else None
        if not lock_info or not installed:
            errors.append(f"npm build dependency {name} is not present in the lock and local install")
            continue
        _, manifest = installed
        lock_version = str(lock_info.get("version", "unknown"))
        installed_version = str(manifest.get("version", "unknown"))
        if lock_version != installed_version:
            errors.append(f"npm build dependency {name} version mismatch: lock {lock_version}, installed {installed_version}")
        repository = manifest.get("repository")
        repository_url = repository.get("url") if isinstance(repository, dict) else repository
        dev_rows.append({
            "name": name,
            "lock_version": lock_version,
            "installed_version": installed_version,
            "license": license_expression(manifest),
            "source": clean_public_url(repository_url) or clean_public_url(manifest.get("homepage")),
        })
    return [discovered[key] for key in sorted(discovered)], dev_rows


def python_site_packages(root: Path) -> list[Path]:
    candidates = [root / ".venv" / "Lib" / "site-packages"]
    candidates.extend(sorted((root / ".venv" / "lib").glob("python*/site-packages")))
    return [path for path in candidates if path.is_dir()]


def python_license_files(dist_info: Path, metadata) -> list[tuple[Path, str]]:
    declared = metadata.get_all("License-File", [])
    candidates: list[Path] = []
    for value in declared:
        relative = PurePosixPath(value.replace("\\", "/"))
        if relative.is_absolute() or ".." in relative.parts:
            continue
        path = dist_info.joinpath(*relative.parts)
        if path.is_file():
            candidates.append(path)
    if not candidates:
        license_dir = dist_info / "licenses"
        if license_dir.is_dir():
            candidates.extend(path for path in sorted(license_dir.rglob("*")) if path.is_file())
    if not candidates:
        candidates.extend(
            path for path in sorted(dist_info.iterdir())
            if path.is_file() and re.match(r"^(license|licence|copying|notice|copyright)([-_. ]|$)", path.name, re.I)
        )
    output = []
    for path in candidates:
        try:
            rel = path.relative_to(dist_info).as_posix()
        except ValueError:
            continue
        output.append((path, rel))
    return output


def python_source(metadata) -> str | None:
    links = []
    for entry in metadata.get_all("Project-URL", []):
        label, sep, url = entry.partition(",")
        if sep:
            links.append((label.strip(), url.strip()))
    home = metadata.get("Home-page")
    if home:
        links.append(("Homepage", home.strip()))
    return first_public_url(links)


def collect_python(root: Path, errors: list[str], notes: list[str], generated: list[str]):
    lock_path = root / "server" / "requirements.lock.txt"
    locked = {}
    unsupported = []
    for line in lock_path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        match = re.fullmatch(r"([A-Za-z0-9_.-]+)==([^\s;]+)", stripped)
        if not match:
            unsupported.append(stripped)
            continue
        name, version = match.groups()
        locked[canonical_name(name)] = (name, version)
    for line in unsupported:
        errors.append(f"requirements.lock contains an unsupported non-exact entry: {line}")

    metadata_by_name = {}
    for site in python_site_packages(root):
        for path in site.glob("*.dist-info/METADATA"):
            try:
                from email.parser import Parser
                message = Parser().parsestr(path.read_text(encoding="utf-8", errors="replace"))
            except OSError:
                continue
            name = message.get("Name")
            if name:
                metadata_by_name[canonical_name(name)] = (path.parent, message)

    rows = []
    for key in sorted(locked):
        name, lock_version = locked[key]
        found = metadata_by_name.get(key)
        if not found:
            errors.append(f"python package {name}=={lock_version} is missing from local .venv dist metadata")
            rows.append({"name": name, "lock_version": lock_version, "installed_version": "MISSING",
                         "license": "unknown", "source": None, "licenses": []})
            continue
        dist_info, metadata = found
        installed_version = str(metadata.get("Version", "unknown"))
        if installed_version != lock_version:
            errors.append(f"python package {name} version mismatch: lock {lock_version}, installed {installed_version}")
        expression = metadata.get("License-Expression") or metadata.get("License")
        if not expression:
            expression = "Not declared in installed metadata; see the included license text"
            notes.append(f"python {name}=={lock_version}: License and License-Expression fields are absent")
        license_files = python_license_files(dist_info, metadata)
        copy_paths = copy_license_files(
            license_files, f"python/{canonical_name(name)}", lock_version,
        ) if license_files else []
        generated.extend(copy_paths)
        if not license_files:
            errors.append(f"python package {name}=={lock_version} has no installed license text file")
        source = python_source(metadata)
        if source is None:
            notes.append(f"python {name}=={lock_version}: no public source/homepage URL is declared in dist metadata")
        rows.append({
            "name": name,
            "lock_version": lock_version,
            "installed_version": installed_version,
            "license": str(expression),
            "source": source,
            "licenses": copy_paths,
        })
    return rows


def source_cell(source: str | None) -> str:
    return f"[Source]({source})" if source else "Not declared in installed metadata"


def license_cell(paths: list[str]) -> str:
    if not paths:
        return "**MISSING**"
    return "<br>".join(f"[text]({relative_markdown(path)})" for path in paths)


def render_notices(npm_rows: list[dict], python_rows: list[dict], dev_rows: list[dict], notes: list[str], errors: list[str]) -> str:
    lines = [
        "# Third-party notices",
        "",
        "This notice covers browser runtime packages reachable from `client/package.json` runtime dependencies and Python packages pinned in `server/requirements.lock.txt`. Versions and license statements are read from the lock files and the corresponding local installed package metadata. Full license texts are copied under `third_party_licenses/`.",
        "",
        "Regenerate with `python scripts/generate-third-party-notices.py`. The generator does not fetch packages or license text from the network.",
        "",
        "## Browser runtime dependencies",
        "",
        "The runtime set follows the installed dependency graph rooted at the direct `dependencies` entries in `client/package.json`; direct and installed transitive dependencies are listed.",
        "",
        "| Package | Locked / installed version | Declared license | Source | Full license text |",
        "|---|---:|---|---|---|",
    ]
    for row in npm_rows:
        version = f"{row['lock_version']} / {row['installed_version']}"
        if row["lock_version"] != row["installed_version"]:
            version += " (mismatch)"
        lines.append(
            f"| `{md(row['name'])}` | `{md(version)}` | {md(row['license'])} | {source_cell(row['source'])} | {license_cell(row['licenses'])} |"
        )

    lines.extend([
        "",
        "## Python packages",
        "",
        "Every exact pin in `server/requirements.lock.txt` is listed, including test and server-support packages; installed versions are compared with the lock before the notice is generated.",
        "",
        "| Package | Locked / installed version | Declared license | Source | Full license text |",
        "|---|---:|---|---|---|",
    ])
    for row in python_rows:
        version = f"{row['lock_version']} / {row['installed_version']}"
        if row["lock_version"] != row["installed_version"]:
            version += " (mismatch)"
        lines.append(
            f"| `{md(row['name'])}` | `{md(version)}` | {md(row['license'])} | {source_cell(row['source'])} | {license_cell(row['licenses'])} |"
        )

    lines.extend([
        "",
        "## Build-time tools",
        "",
        "These are the direct `client/package.json` development dependencies used to build or type-check the frontend. They are not browser runtime packages; platform-specific transitive tool binaries are not copied into this runtime notice set.",
        "",
        "| Package | Locked / installed version | Declared license | Source |",
        "|---|---:|---|---|",
    ])
    for row in dev_rows:
        version = f"{row['lock_version']} / {row['installed_version']}"
        if row["lock_version"] != row["installed_version"]:
            version += " (mismatch)"
        lines.append(f"| `{md(row['name'])}` | `{md(version)}` | {md(row['license'])} | {source_cell(row['source'])} |")

    lines.extend([
        "",
        "## Included fonts and tokenizer data",
        "",
        "- Source Sans Pro 2.045 Roman (weights 400, 600, and 700) is self-hosted from Adobe's upstream commit [`ce77773581f4d454f0fa985c073bb25c721bfcf5`](https://github.com/adobe-fonts/source-sans/tree/ce77773581f4d454f0fa985c073bb25c721bfcf5/WOFF2/TTF). The included font files were hash-checked against that upstream revision. License: SIL Open Font License 1.1; full text: [SourceSansPro-LICENSE.txt](client/public/fonts/SourceSansPro-LICENSE.txt).",
        "- Tokenizer model/vocabulary files and their provenance are listed in [tokenizers/NOTICE.txt](client/public/tokenizers/NOTICE.txt), with the existing [Apache-2.0](client/public/tokenizers/LICENSE-APACHE-2.0.txt) and [MIT](client/public/tokenizers/LICENSE-CLIP-MIT.txt) license copies.",
        "",
        "## Metadata notes",
        "",
    ])
    if notes:
        for note in notes:
            lines.append(f"- {md(note)}")
    else:
        lines.append("- No missing license-expression, source-link, or other package metadata fields were found in the locked runtime set.")

    if errors:
        lines.extend(["", "## Release blockers reported by the generator", ""])
        for error in errors:
            lines.append(f"- {md(error)}")
    else:
        lines.extend(["", "No lock/install version mismatches or missing license-text copies were found."])
    lines.append("")
    return "\n".join(lines)


def remove_previous_generated_files(generated: list[str]) -> None:
    for relative in generated:
        path = PurePosixPath(relative)
        if path.parts[:1] == ("third_party_licenses",):
            path = PurePosixPath(*path.parts[1:])
        if path.is_absolute() or ".." in path.parts or not path.parts or path.parts[0] not in {"npm", "python"}:
            continue
        target = LICENSE_ROOT.joinpath(*path.parts)
        # The index only owns files inside this generated directory.
        if not target.resolve().is_relative_to(LICENSE_ROOT.resolve()):
            continue
        try:
            target.unlink()
        except FileNotFoundError:
            pass
        parent = target.parent
        while parent != LICENSE_ROOT and LICENSE_ROOT in parent.parents:
            try:
                parent.rmdir()
            except OSError:
                break
            parent = parent.parent


def main() -> int:
    errors: list[str] = []
    notes: list[str] = []
    previous = []
    try:
        previous_value = read_json(INDEX_PATH)
        previous = [item for item in previous_value.get("files", []) if isinstance(item, str)]
    except FileNotFoundError:
        pass
    except (OSError, ValueError, json.JSONDecodeError):
        errors.append("third_party_licenses generation index could not be read; existing files were left untouched")

    LICENSE_ROOT.mkdir(parents=True, exist_ok=True)
    remove_previous_generated_files(previous)
    generated: list[str] = []
    try:
        npm_rows, dev_rows = collect_npm(ROOT, errors, notes, generated)
        python_rows = collect_python(ROOT, errors, notes, generated)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        # Do not include exception strings: filesystem errors can disclose private paths.
        errors.append(f"dependency metadata could not be read ({type(error).__name__})")
        npm_rows, dev_rows, python_rows = [], [], []

    content = render_notices(npm_rows, python_rows, dev_rows, notes, errors)
    NOTICES_PATH.write_text(content, encoding="utf-8", newline="\n")
    INDEX_PATH.write_text(
        json.dumps({"files": sorted(set(generated))}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    print(f"Generated notices for {len(npm_rows)} browser packages, {len(python_rows)} Python pins, and {len(dev_rows)} direct build tools.")
    for note in notes:
        print(f"Metadata note: {note}")
    for error in errors:
        print(f"Release check: {error}")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
