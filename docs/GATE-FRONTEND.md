# Gate 连接模式

此说明对应 `Dockerfile.gate` 与 `compose.gate.yaml`，启动工作台前端和轻量适配服务。Gate 需单独部署，支持的版本与接口见 [Gate 版本要求](GATE-COMPATIBILITY.md)。

## 连接边界

浏览器 → 工作台适配服务 → 已有 Gate → NovelAI。用户在页面填写 Gate 分配的 Key，适配服务将该 Key 交给 Gate。官方 NAI Key 留在 Gate；工作台不直连 NovelAI，不读取官方余额，也没有独立用户计费。

适配服务需要 Gate 提供用户/订阅、图像生成、Vibe 编码、放大、导演工具、队列状态和标签建议等接口。它不是面向任意 OpenAI-compatible 中转的客户端。`WORKBENCH_GATE_URL` 必须从工作台容器内可达。

工作台不保存服务端图库或长期结果。原图仅在请求处理期间进入适配层内存；作品与草稿存入当前浏览器 IndexedDB，并按站点地址和 Gate Key 隔离。更换 Key 前应先导出图库备份。

刷新页面会保留提示词、设置和图库，但会清空当前任务的源图、蒙版、Vibe、精准参考和导演参考；显式导入备份时会恢复其中的附件。

五框批量由浏览器串行提交，每张结果本地保存后再继续。请保持页面打开；刷新、关闭或断网后，服务端不能恢复浏览器中的在途队列。只有明确未开始的限流/排队拒绝会等待后继续；未知结果不自动重放。报价是本地估算，不代表 Gate 的实际扣费或额度；免费参数限制和结算由 Gate 决定。

Vibe 与精准参考按模型能力启用。普通 V5 文生图/图生图不启用这两类参考；V5 Curated 重绘按 V4.5 的参考能力分类，并使用对应的 V4.5 inpainting 请求模型。最终可用性仍受 Gate 和账户能力限制。

## 构建与运行

需要 Docker Compose v2 和一个可访问的 Gate 服务。`.env.gate.example` 是无凭据示例：复制为 `.env`，只需设置容器可访问的 `WORKBENCH_GATE_URL`。不要在此文件中放入 Gate Key；Key 由用户在浏览器中输入。

```sh
cp .env.gate.example .env
# 编辑 .env 中的 WORKBENCH_GATE_URL
docker compose --env-file .env -f compose.gate.yaml pull
docker compose --env-file .env -f compose.gate.yaml up -d
```

默认镜像为 `ghcr.io/kronosxup/nai-workbench:beta`。预发布版本标签（例如 `v0.1.0-beta.1`）会同时发布 `beta`；稳定版本标签（例如 `v1.2.3`）会更新 `latest`。在 Actions 中从 `main` 手动运行发布工作流会更新 `beta` 并生成 `sha-...` 镜像标签。可在 `.env` 中设置 `WORKBENCH_IMAGE=ghcr.io/kronosxup/nai-workbench:<版本标签>` 固定版本。

更新镜像时运行 `pull` 和 `up -d`。Compose 默认创建自己的网络，Gate URL 可以是容器可访问的主机名或地址。Gate 若监听在同一台 Docker 主机上，可使用 `http://host.docker.internal:<Gate端口>`；配置会把该主机名映射到宿主机网关。Gate 还需监听在容器可达的宿主机接口上；只监听 `127.0.0.1` 时，容器无法通过宿主机网关访问。

如果 Gate 已在另一个 Docker 网络中，可选用网络覆盖文件。把网络名写入 `.env`，并在每条 Compose 命令中加入 `-f compose.gate-network.yaml`：

将以下两项写入 `.env`：

```dotenv
GATE_DOCKER_NETWORK=gate_default
WORKBENCH_GATE_URL=http://gate:8000
```

```sh
docker compose --env-file .env -f compose.gate.yaml -f compose.gate-network.yaml pull
docker compose --env-file .env -f compose.gate.yaml -f compose.gate-network.yaml up -d
```

也可从本地源码构建。构建主机需要访问 Docker 镜像仓库、npm 和 PyPI；默认会使用 `node:22-alpine` 与 `python:3.12-slim` 作为构建基础镜像，可通过 `.env` 中的 `NODE_IMAGE`、`PYTHON_IMAGE` 覆盖：

```sh
docker compose --env-file .env -f compose.gate.yaml -f compose.gate.build.yaml up --build -d
```

前端在镜像构建时通过 `npm ci` 编译，再按 `server/requirements.lock.txt` 安装 Python 运行依赖；不依赖 Gate 服务镜像、预制 wheel 或本机 `client/dist`。

发布源码包使用文件清单打包：

```sh
python scripts/package-gate-release.py
```

脚本默认在 `artifacts/` 下新建带时间戳的目录，内含解包目录、仅含文件项的 tar 包和 SHA-256 清单。输入文件统一为 `0644`，输出树目录为 `0755`；清单记录目录权限。也可用 `--output-dir <新目录>` 指定输出位置。包中不含 `.env`、数据、日志、构建产物、旧设计材料、未引用的 SVG、Gate 服务源码或私有部署脚本。

容器在切换到 UID/GID 10001 前会把运行代码和静态资源设置为可读、目录可遍历。根文件系统只读，仅 `/tmp` 使用 64 MB tmpfs；丢弃 Linux capabilities、启用 `no-new-privileges`，并限制内存 768 MB、CPU 2 核和进程数 128。服务使用单个 Uvicorn worker，不挂载数据库或图库目录。

## 网络入口

Compose 默认只绑定 `127.0.0.1:8787`。可将独立 HTTPS 反向代理转发到该端口；证书、续期和公网访问控制由反代负责，不包含在本项目内。只有在反代容器需要通过 Docker 网络访问时，才按该网络布局调整绑定地址。不要公开 Gate 管理页或 Gate Key。

健康检查访问 `/api/health`，要求返回 Gate 模式。部署验证还应确认容器为非 root、根文件系统只读、没有意外卷挂载，并通过工作台页面检查静态资源和 Gate 连接。构建或静态检查不能代替真实浏览器与目标 Gate 版本兼容性验收。

## 维护者发布镜像

推送 `v*` 版本标签会先运行完整离线检查，通过后再构建并发布 GHCR 镜像。带连字符的预发布标签更新 `beta`，不改动 `latest`；稳定标签更新 `latest`。从 `main` 手动运行发布工作流也会先完成离线检查，再发布 `beta` 与该提交的 `sha-...` 标签。

首次发布后，由仓库维护者将 `nai-workbench` 的 GHCR 包可见性设为 Public，之后部署主机才可匿名拉取。该设置只需在包首次创建后处理一次。
