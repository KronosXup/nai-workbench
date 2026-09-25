# 开发与离线检查

需要 Python 3.12、Node.js 22.18 或更高版本和 npm。本地运行还需要一个从本机可访问的 Gate 地址。Gate URL 通过 `WORKBENCH_GATE_URL` 环境变量传给适配服务；将下面示例地址替换为当前 Gate 的实际地址。

```sh
python -m venv .venv
# Linux/macOS: source .venv/bin/activate
# PowerShell:   .venv\Scripts\Activate.ps1
python -m pip install -r server/requirements.lock.txt
```

从仓库根目录启动适配服务。下面分别给出 POSIX shell 和 PowerShell 的环境变量写法：

```sh
export WORKBENCH_GATE_URL="http://127.0.0.1:8000"
python -m uvicorn app.gate_bridge:app --app-dir server --reload --host 127.0.0.1 --port 8787
```

```powershell
$env:WORKBENCH_GATE_URL = "http://127.0.0.1:8000"
python -m uvicorn app.gate_bridge:app --app-dir server --reload --host 127.0.0.1 --port 8787
```

另开终端启动前端：

```sh
cd client
npm ci
npm run dev
```

打开 Vite 输出的本地地址（默认 `http://127.0.0.1:5173`）。Vite 将 `/api` 转发到本机 `127.0.0.1:8787`。登录使用 Gate 分配的 Key；工作台不接受官方 NAI Key，也不直连 NovelAI。

## 离线检查

首次安装 Python 和 npm 依赖需要访问 PyPI 与 npm registry。安装完成后，从仓库根目录运行：

```sh
python scripts/check-release.py
```

检查入口构建客户端，运行公开 Gate 桥接/安全与适配器测试、全部 `scripts/check-*.mjs`，以及画布工具、存储、项目和 Pixel Snap 的客户端测试。检查使用 mock 上游、临时假数据，并阻止 Python 与 Node 建立非 loopback 网络连接；不需要 Gate 地址、凭据或真实 NovelAI 请求。脚本不会安装依赖。

GitHub Actions 使用 Python 3.12 和 Node.js 22 执行同一个检查入口。客户端测试直接导入 TypeScript 源文件，因此本地 Node.js 22 需要 22.18 或更高版本。
