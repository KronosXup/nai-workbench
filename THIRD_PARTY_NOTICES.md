# Third-party notices

This notice covers browser runtime packages reachable from `client/package.json` runtime dependencies and Python packages pinned in `server/requirements.lock.txt`. Versions and license statements are read from the lock files and the corresponding local installed package metadata. Full license texts are copied under `third_party_licenses/`.

Regenerate with `python scripts/generate-third-party-notices.py`. The generator does not fetch packages or license text from the network.

## Browser runtime dependencies

The runtime set follows the installed dependency graph rooted at the direct `dependencies` entries in `client/package.json`; direct and installed transitive dependencies are listed.

| Package | Locked / installed version | Declared license | Source | Full license text |
|---|---:|---|---|---|
| `@huggingface/tokenizers` | `0.1.3 / 0.1.3` | Apache-2.0 | [Source](https://github.com/huggingface/tokenizers.js) | [text](third_party_licenses/npm/@huggingface/tokenizers/0.1.3/LICENSE) |
| `@noble/hashes` | `1.8.0 / 1.8.0` | MIT | [Source](https://github.com/paulmillr/noble-hashes) | [text](third_party_licenses/npm/@noble/hashes/1.8.0/LICENSE) |
| `lucide-react` | `0.468.0 / 0.468.0` | ISC | [Source](https://github.com/lucide-icons/lucide) | [text](third_party_licenses/npm/lucide-react/0.468.0/LICENSE) |
| `react` | `19.3.0 / 19.3.0` | MIT | [Source](https://github.com/react/react) | [text](third_party_licenses/npm/react/19.3.0/LICENSE) |
| `react-dom` | `19.3.0 / 19.3.0` | MIT | [Source](https://github.com/react/react) | [text](third_party_licenses/npm/react-dom/19.3.0/LICENSE) |
| `scheduler` | `0.28.0 / 0.28.0` | MIT | [Source](https://github.com/react/react) | [text](third_party_licenses/npm/scheduler/0.28.0/LICENSE) |

## Python packages

Every exact pin in `server/requirements.lock.txt` is listed, including test and server-support packages; installed versions are compared with the lock before the notice is generated.

| Package | Locked / installed version | Declared license | Source | Full license text |
|---|---:|---|---|---|
| `annotated-doc` | `0.0.5 / 0.0.5` | MIT | [Source](https://github.com/fastapi/annotated-doc) | [text](third_party_licenses/python/annotated-doc/0.0.5/licenses/LICENSE) |
| `annotated-types` | `0.8.0 / 0.8.0` | MIT | [Source](https://github.com/annotated-types/annotated-types) | [text](third_party_licenses/python/annotated-types/0.8.0/licenses/LICENSE) |
| `anyio` | `4.15.1 / 4.15.1` | MIT | [Source](https://github.com/agronholm/anyio) | [text](third_party_licenses/python/anyio/4.15.1/licenses/LICENSE) |
| `certifi` | `2026.7.22 / 2026.7.22` | MPL-2.0 | [Source](https://github.com/certifi/python-certifi) | [text](third_party_licenses/python/certifi/2026.7.22/licenses/LICENSE) |
| `click` | `8.5.0 / 8.5.0` | BSD-3-Clause | [Source](https://github.com/pallets/click/) | [text](third_party_licenses/python/click/8.5.0/licenses/LICENSE.txt) |
| `colorama` | `0.4.6 / 0.4.6` | Not declared in installed metadata; see the included license text | [Source](https://github.com/tartley/colorama) | [text](third_party_licenses/python/colorama/0.4.6/licenses/LICENSE.txt) |
| `fastapi` | `0.141.1 / 0.141.1` | MIT | [Source](https://github.com/fastapi/fastapi) | [text](third_party_licenses/python/fastapi/0.141.1/licenses/LICENSE) |
| `h11` | `0.16.0 / 0.16.0` | MIT | [Source](https://github.com/python-hyper/h11) | [text](third_party_licenses/python/h11/0.16.0/licenses/LICENSE.txt) |
| `httpcore` | `1.0.9 / 1.0.9` | BSD-3-Clause | [Source](https://github.com/encode/httpcore) | [text](third_party_licenses/python/httpcore/1.0.9/licenses/LICENSE.md) |
| `httptools` | `0.8.0 / 0.8.0` | MIT | [Source](https://github.com/MagicStack/httptools) | [text](third_party_licenses/python/httptools/0.8.0/licenses/LICENSE)<br>[text](third_party_licenses/python/httptools/0.8.0/licenses/vendor/http-parser/LICENSE-MIT)<br>[text](third_party_licenses/python/httptools/0.8.0/licenses/vendor/llhttp/LICENSE) |
| `httpx` | `0.28.1 / 0.28.1` | BSD-3-Clause | [Source](https://github.com/encode/httpx) | [text](third_party_licenses/python/httpx/0.28.1/licenses/LICENSE.md) |
| `idna` | `3.20 / 3.20` | BSD-3-Clause | [Source](https://github.com/kjd/idna) | [text](third_party_licenses/python/idna/3.20/licenses/LICENSE.md) |
| `iniconfig` | `2.3.0 / 2.3.0` | MIT | [Source](https://github.com/pytest-dev/iniconfig) | [text](third_party_licenses/python/iniconfig/2.3.0/licenses/LICENSE) |
| `packaging` | `26.3 / 26.3` | Apache-2.0 OR BSD-2-Clause | [Source](https://github.com/pypa/packaging) | [text](third_party_licenses/python/packaging/26.3/licenses/LICENSE)<br>[text](third_party_licenses/python/packaging/26.3/licenses/LICENSE.APACHE)<br>[text](third_party_licenses/python/packaging/26.3/licenses/LICENSE.BSD) |
| `pillow` | `12.3.0 / 12.3.0` | MIT-CMU | [Source](https://github.com/python-pillow/Pillow) | [text](third_party_licenses/python/pillow/12.3.0/licenses/LICENSE) |
| `pluggy` | `1.6.0 / 1.6.0` | MIT | Not declared in installed metadata | [text](third_party_licenses/python/pluggy/1.6.0/licenses/LICENSE) |
| `pydantic` | `2.13.5 / 2.13.5` | MIT | [Source](https://github.com/pydantic/pydantic) | [text](third_party_licenses/python/pydantic/2.13.5/licenses/LICENSE) |
| `pydantic_core` | `2.46.5 / 2.46.5` | MIT | [Source](https://github.com/pydantic/pydantic/tree/main/pydantic-core) | [text](third_party_licenses/python/pydantic-core/2.46.5/licenses/LICENSE) |
| `Pygments` | `2.21.0 / 2.21.0` | BSD-2-Clause | [Source](https://github.com/pygments/pygments) | [text](third_party_licenses/python/pygments/2.21.0/licenses/AUTHORS)<br>[text](third_party_licenses/python/pygments/2.21.0/licenses/LICENSE) |
| `pytest` | `9.1.1 / 9.1.1` | MIT | [Source](https://github.com/pytest-dev/pytest) | [text](third_party_licenses/python/pytest/9.1.1/licenses/LICENSE) |
| `python-dotenv` | `1.2.3 / 1.2.3` | BSD-3-Clause | [Source](https://github.com/theskumar/python-dotenv) | [text](third_party_licenses/python/python-dotenv/1.2.3/licenses/LICENSE) |
| `python-multipart` | `0.0.32 / 0.0.32` | Apache-2.0 | [Source](https://github.com/Kludex/python-multipart) | [text](third_party_licenses/python/python-multipart/0.0.32/licenses/LICENSE.txt) |
| `PyYAML` | `6.0.3 / 6.0.3` | MIT | [Source](https://github.com/yaml/pyyaml) | [text](third_party_licenses/python/pyyaml/6.0.3/licenses/LICENSE) |
| `starlette` | `1.6.0 / 1.6.0` | BSD-3-Clause | [Source](https://github.com/Kludex/starlette) | [text](third_party_licenses/python/starlette/1.6.0/licenses/LICENSE.md) |
| `typing_extensions` | `4.16.0 / 4.16.0` | PSF-2.0 | [Source](https://github.com/python/typing_extensions) | [text](third_party_licenses/python/typing-extensions/4.16.0/licenses/LICENSE) |
| `typing-inspection` | `0.4.4 / 0.4.4` | MIT | [Source](https://github.com/pydantic/typing-inspection) | [text](third_party_licenses/python/typing-inspection/0.4.4/licenses/LICENSE) |
| `uvicorn` | `0.53.0 / 0.53.0` | BSD-3-Clause | [Source](https://github.com/Kludex/uvicorn) | [text](third_party_licenses/python/uvicorn/0.53.0/licenses/LICENSE.md) |
| `watchfiles` | `1.2.0 / 1.2.0` | MIT | [Source](https://github.com/samuelcolvin/watchfiles) | [text](third_party_licenses/python/watchfiles/1.2.0/licenses/LICENSE) |
| `websockets` | `17.1 / 17.1` | BSD-3-Clause | [Source](https://github.com/python-websockets/websockets) | [text](third_party_licenses/python/websockets/17.1/licenses/LICENSE) |

## Build-time tools

These are the direct `client/package.json` development dependencies used to build or type-check the frontend. They are not browser runtime packages; platform-specific transitive tool binaries are not copied into this runtime notice set.

| Package | Locked / installed version | Declared license | Source |
|---|---:|---|---|
| `@types/react` | `19.3.0 / 19.3.0` | MIT | [Source](https://github.com/DefinitelyTyped/DefinitelyTyped) |
| `@types/react-dom` | `19.3.0 / 19.3.0` | MIT | [Source](https://github.com/DefinitelyTyped/DefinitelyTyped) |
| `@vitejs/plugin-react` | `4.7.0 / 4.7.0` | MIT | [Source](https://github.com/vitejs/vite-plugin-react) |
| `typescript` | `5.7.3 / 5.7.3` | Apache-2.0 | [Source](https://github.com/microsoft/TypeScript) |
| `vite` | `6.4.3 / 6.4.3` | MIT | [Source](https://github.com/vitejs/vite) |

## Included fonts and tokenizer data

- Source Sans Pro 2.045 Roman (weights 400, 600, and 700) is self-hosted from Adobe's upstream commit [`ce77773581f4d454f0fa985c073bb25c721bfcf5`](https://github.com/adobe-fonts/source-sans/tree/ce77773581f4d454f0fa985c073bb25c721bfcf5/WOFF2/TTF). The included font files were hash-checked against that upstream revision. License: SIL Open Font License 1.1; full text: [SourceSansPro-LICENSE.txt](client/public/fonts/SourceSansPro-LICENSE.txt).
- Tokenizer model/vocabulary files and their provenance are listed in [tokenizers/NOTICE.txt](client/public/tokenizers/NOTICE.txt), with the existing [Apache-2.0](client/public/tokenizers/LICENSE-APACHE-2.0.txt) and [MIT](client/public/tokenizers/LICENSE-CLIP-MIT.txt) license copies.

## Metadata notes

- python colorama==0.4.6: License and License-Expression fields are absent
- python pluggy==1.6.0: no public source/homepage URL is declared in dist metadata

No lock/install version mismatches or missing license-text copies were found.
