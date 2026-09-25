# Gate 连接模式

此说明对应 `Dockerfile.gate` 与 `compose.gate.yaml`，启动工作台前端和轻量适配服务。Gate 需单独部署，支持的版本与接口见 [Gate 版本要求](GATE-COMPATIBILITY.md)。

## 连接边界

浏览器 → 工作台适配服务 → 已有 Gate → NovelAI。用户在页面填写 Gate 分配的 Key，适配服务将该 Key 交给 Gate。官方 NAI Key 留在 Gate；工作台不直连 NovelAI，不读取官方余额，也没有独立用户计费。

适配服务需要 Gate 提供用户/订阅、图像生成、Vibe 编码、放大、导演工具、队列状态和标签建议等接口。它不是面向任意 OpenAI-compatible 中转的客户端。连接地址必须从工作台容器所在 Docker 网络可达。

工作台不保存服务端图库或长期结果。原图仅在请求处理期间进入适配层内存；作品与草稿存入当前浏览器 IndexedDB，并按站点地址和 Gate Key 隔离。更换 Key 前应先导出图库备份。

五框批量由浏览器串行提交，每张结果本地保存后再继续。请保持页面打开；刷新、关闭或断网后，服务端不能恢复浏览器中的在途队列。只有明确未开始的限流/排队拒绝会等待后继续；未知结果不自动重放。报价是本地估算，不代表 Gate 的实际扣费或额度；免费参数限制和结算由 Gate 决定。

Vibe 与精准参考按模型能力启用。普通 V5 文生图/图生图不启用这两类参考；V5 Curated 重绘按 V4.5 的参考能力分类，并使用对应的 V4.5 inpainting 请求模型。最终可用性仍受 Gate 和账户能力限制。

## 构建与运行

需要 Docker Compose v2、一个现有 Gate 服务和两者共享的 Docker 网络。`.env.gate.example` 是无凭据示例：复制为 `.env`，设置 Gate 在容器网络内可达的 URL、网络名和所需端口。该文件不得放入版本控制或包含 Gate Key。

```sh
cp .env.gate.example .env
# 编辑 .env 中的 WORKBENCH_GATE_URL 与 GATE_DOCKER_NETWORK
docker compose --env-file .env -f compose.gate.yaml config
docker compose --env-file .env -f compose.gate.yaml up --build -d
```

镜像使用公开 `node:22-alpine` 与 `python:3.12-slim` 多阶段构建：先用 `npm ci` 构建静态前端，再按 `server/requirements.lock.txt` 安装 Python 运行依赖。构建不依赖 Gate 服务镜像、预制 wheel 或本机 `client/dist`；构建主机需要能访问 Docker 镜像仓库、npm 和 PyPI。可通过 `.env` 中的 `NODE_IMAGE`、`PYTHON_IMAGE` 覆盖默认基础镜像。

发布源码包使用文件清单打包：

```sh
python scripts/package-gate-release.py
```

脚本默认在 `artifacts/` 下新建带时间戳的目录，内含解包目录、仅含文件项的 tar 包和 SHA-256 清单。输入文件统一为 `0644`，输出树目录为 `0755`；清单记录目录权限。也可用 `--output-dir <新目录>` 指定输出位置。包中不含 `.env`、数据、日志、构建产物、旧设计材料、未引用的 SVG、Gate 服务源码或私有部署脚本。

容器在切换到 UID/GID 10001 前会把运行代码和静态资源设置为可读、目录可遍历。根文件系统只读，仅 `/tmp` 使用 64 MB tmpfs；丢弃 Linux capabilities、启用 `no-new-privileges`，并限制内存 768 MB、CPU 2 核和进程数 128。服务使用单个 Uvicorn worker，不挂载数据库或图库目录。

## 网络入口

Compose 默认只绑定 `127.0.0.1:8787`。可将独立 HTTPS 反向代理转发到该端口；证书、续期和公网访问控制由反代负责，不包含在本项目内。只有在反代容器需要通过 Docker 网络访问时，才按该网络布局调整绑定地址。不要公开 Gate 管理页或 Gate Key。

健康检查访问 `/api/health`，要求返回 Gate 模式。部署验证还应确认容器为非 root、根文件系统只读、没有意外卷挂载，并通过工作台页面检查静态资源和 Gate 连接。构建或静态检查不能代替真实浏览器与目标 Gate 版本兼容性验收。
