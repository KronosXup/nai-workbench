# Gate 与 NAI 工作台完整部署教程

本文把 Gate、工作台和可选的 HTTPS 入口部署在同一台 Linux 服务器或 NAS 上。工作台使用预构建镜像，Gate 从作者源码构建。已有 Gate 的用户可直接看第 8 节，不必再装一套。

本文核对版本：工作台 `v0.1.0-beta.4`；Gate 上游提交 [`4b0ff69`](https://github.com/fangchen2003/service-tools/tree/4b0ff693b3ed6aa4f2006162453d32783c011718)。命令在服务器的终端执行；SSH 隧道命令在自己的电脑执行。示例密码、Token、域名和服务器地址都需要自行替换。

## 1. 三个部分各自做什么

```text
用户浏览器 → HTTPS 入口（Caddy，可选）→ 工作台 → Gate → NovelAI
站长电脑   → SSH 隧道                 → Gate 管理后台
```

- **Gate** 保存官方 Token、用户 Key 和用量，负责调用 NovelAI、权限与费用限制。
- **工作台** 提供绘图页面和适配服务；用户填写 Gate Key 登录。
- **Caddy** 为公网工作台提供 HTTPS，并自动管理域名证书。

浏览器里输入的是 Gate 新建的用户 Key，不是 NovelAI 官方 Token。图片、草稿与画布工程保存在各用户自己的浏览器；Gate 的账号、Key 和用量保存在服务器。

本教程的 Gate 后台只开放在服务器本机，通过 SSH 隧道管理，不直接向公网开放。服务器只需向普通用户提供工作台入口。

## 2. 准备环境和目录

需要 Docker Engine、Docker Compose v2、Git，以及能访问 GitHub、GHCR、基础镜像仓库、PyPI 和 NovelAI 的服务器。

Linux 上按 [Docker 官方安装说明](https://docs.docker.com/engine/install/)安装。飞牛等 NAS 可使用系统的 Docker 功能，在 SSH 终端执行后续命令。先确认：

```sh
docker version
docker compose version
git --version
```

工作台 beta.4 的预构建镜像用于 `linux/amd64`。ARM 设备需要改用[源码构建方式](GATE-FRONTEND.md)，本文的直接拉取步骤不适用。

在有足够空间且能长期保留的目录下执行：

```sh
mkdir nai-stack
cd nai-stack
git clone https://github.com/fangchen2003/service-tools.git gate
git -C gate checkout 4b0ff693b3ed6aa4f2006162453d32783c011718
mkdir gate-data
```

最终目录如下。不要在 `gate/` 内启动作者原有的 Compose；本文使用外层这一份。

```text
nai-stack/
  gate/                 Gate 源码
  gate-data/            Gate 数据库和会话密钥
  compose.yaml          本文的部署配置
  .env                  密码、官方 Token 和运行选项
  compose.https.yaml    可选的 HTTPS 配置
  Caddyfile             可选的域名配置
  caddy-data/           HTTPS 启用后保存证书及续期信息
  caddy-config/
```

## 3. 配置 Gate 与工作台

在 `nai-stack` 下创建 `.env`：

```dotenv
ADMIN_PASSWORD=请替换为独立的强密码
NAI_TOKENS=请替换为NovelAI的Persistent_API_Token

WORKBENCH_IMAGE=ghcr.io/kronosxup/nai-workbench:v0.1.0-beta.4
GATE_IMAGE=nai-gate:4b0ff69

# 本文后台只通过本机 HTTP / SSH 隧道访问。
ADMIN_COOKIE_SECURE=0

# 允许站长对个别 Key 开放图生图；仍需在后台给该 Key 授权。
ALLOW_IMG2IMG=1

# 关闭默认的闲置 Key 自动删除，避免几天不用就丢失 Key。
KEY_INACTIVITY_DELETE_DAYS=0

GLOBAL_CONCURRENCY=1
KEY_CONCURRENCY=1
IMAGE_MIN_INTERVAL=15
KEY_IMAGE_MIN_INTERVAL=15
GLOBAL_MONTHLY_ANLAS=10000
GLOBAL_DAILY_V5=150
```

官方 Token 在 NovelAI 的 `User Settings → Account → Get Persistent API Token` 获取。多个账号可在 `NAI_TOKENS` 中用英文逗号分隔。`.env` 只保存在服务器，不发给用户、不提交到仓库。若值里包含 `$` 等 Compose 特殊字符，用单引号包住整个值。

```sh
chmod 600 .env
```

这里的 `ADMIN_COOKIE_SECURE=0` 配合后面固定的 `127.0.0.1` 端口和 SSH 隧道使用。如果自行把后台改成公网 HTTPS，改回 `1` 并重建 Gate 容器。不要把本教程的本机 HTTP 设置直接搬到公网 HTTP 后台。

全站额度按自己的账号能力调整；上面的数字是 Gate 的默认额度，不代表官方赠送数量。并发保持 1 起步，工作台的批量会逐张提交。

创建 `compose.yaml`：

```yaml
name: nai-stack

services:
  gate:
    build: ./gate
    image: ${GATE_IMAGE:-nai-gate:4b0ff69}
    restart: unless-stopped
    environment:
      ADMIN_PASSWORD: ${ADMIN_PASSWORD:?Set ADMIN_PASSWORD}
      NAI_TOKENS: ${NAI_TOKENS:?Set NAI_TOKENS}
      ADMIN_COOKIE_SECURE: ${ADMIN_COOKIE_SECURE:-0}
      ALLOW_IMG2IMG: ${ALLOW_IMG2IMG:-1}
      KEY_INACTIVITY_DELETE_DAYS: ${KEY_INACTIVITY_DELETE_DAYS:-0}
      GLOBAL_CONCURRENCY: ${GLOBAL_CONCURRENCY:-1}
      KEY_CONCURRENCY: ${KEY_CONCURRENCY:-1}
      IMAGE_MIN_INTERVAL: ${IMAGE_MIN_INTERVAL:-15}
      KEY_IMAGE_MIN_INTERVAL: ${KEY_IMAGE_MIN_INTERVAL:-15}
      GLOBAL_MONTHLY_ANLAS: ${GLOBAL_MONTHLY_ANLAS:-10000}
      GLOBAL_DAILY_V5: ${GLOBAL_DAILY_V5:-150}
      DATA_DIR: /app/data
      TZ: Asia/Shanghai
    ports:
      - "127.0.0.1:18000:8000"
    volumes:
      - ./gate-data:/app/data

  workbench:
    image: ${WORKBENCH_IMAGE:-ghcr.io/kronosxup/nai-workbench:v0.1.0-beta.4}
    restart: unless-stopped
    depends_on:
      - gate
    environment:
      WORKBENCH_GATE_URL: http://gate:8000
    ports:
      - "127.0.0.1:8787:8787"
    read_only: true
    tmpfs:
      - /tmp:size=64m,mode=1777
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    mem_limit: 768m
    cpus: 2
    pids_limit: 128
```

两个服务在 Compose 网络中通过 `http://gate:8000` 通信。不能在工作台容器中填写 `http://127.0.0.1:18000`，那会指向工作台容器自己。

检查并启动：

```sh
docker compose config --quiet
docker compose build gate
docker compose pull workbench
docker compose up -d
docker compose ps
curl -fsS http://127.0.0.1:18000/healthz
curl -fsS http://127.0.0.1:8787/api/health
```

Gate 的 `/healthz` 应显示 `ok: true`、`upstream: true`；后者仅表示配置了 Token，不证明官方 Token 有效。工作台应显示 `ok: true`、`mode: "gate"`。这些检查不会生成图片或消耗生图额度。

## 4. 登录后台并新建用户 Key

在自己的电脑上建立隧道，保持终端打开：

```sh
ssh -N -L 18000:127.0.0.1:18000 -L 8787:127.0.0.1:8787 用户名@服务器地址
```

Windows PowerShell 也可使用这条 `ssh` 命令。若电脑本地端口已占用，修改 `-L` 后第一个数字，例如 `-L 18001:127.0.0.1:18000`，然后访问本地 18001。

打开 `http://127.0.0.1:18000/admin`，使用 `.env` 中的管理密码登录。在「密钥管理」新建 Key：

| 要使用的功能 | 需要设置的内容 |
|---|---|
| V4.5 普通绘图 | 设置每日图片数量、有效期等限额 |
| V5 | 模型范围选包含 V5 的选项，并设置 V5 每日次数 |
| 付费规格、参考图附加费、导演工具等 | 按需打开「允许消耗 Anlas」，设置每日／每月预算 |
| 图生图与局部重绘 | 同时打开该 Key 的图生图权限与 Anlas 权限，且全局 `ALLOW_IMG2IMG=1` |

图生图保留 Gate 原有权限要求：即使某个规格预计免费，也需要上述权限。打开权限本身不会生成或扣费。实际请求还受全站预算、上游账号、模型和规格限制。

新 Key 创建后立即复制保存，只把这把用户 Key 给工作台用户。不要把管理员密码或官方 Token 发给他们。不要开启 `SEED_DEMO_KEY`，它会把演示 Key 写进日志。

第一次可先打开 `http://127.0.0.1:8787`，输入刚创建的 Gate Key，确认登录、模型和额度显示正常。单纯连接不需要生成图片。

## 5. 为公网工作台开启 HTTPS

以下示例使用域名。先把域名的 A 记录指向服务器公网 IPv4；只有确实配置了可达 IPv6 时才添加 AAAA。开放公网 TCP 80、443，确认未被其他服务占用。已有反向代理的服务器可以直接把工作台域名转发到本机 `8787`，不再启动第二套 Caddy。

创建 `Caddyfile`，替换其中域名：

```caddyfile
draw.example.com {
    reverse_proxy workbench:8787 {
        flush_interval -1
    }
}
```

创建 `compose.https.yaml`：

```yaml
services:
  caddy:
    image: caddy:2.11.4
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./caddy-data:/data
      - ./caddy-config:/config
```

启动 HTTPS 服务：

```sh
docker compose -f compose.yaml -f compose.https.yaml config --quiet
docker compose -f compose.yaml -f compose.https.yaml up -d caddy
docker compose -f compose.yaml -f compose.https.yaml logs --tail 50 caddy
```

然后访问 `https://draw.example.com`。Caddy 会申请域名证书并安排续期；`caddy-data` 必须持久保留，验证所需端口也要保持可达。[Caddy 官方 HTTPS 说明](https://caddyserver.com/docs/quick-starts/https)

这套配置只公开工作台，Gate 仍通过 SSH 隧道管理。使用 Nginx 等其他反代时，要关闭生成接口的响应缓冲，并给长时间生成留足读取超时。

没有域名时，可以先用 SSH 隧道完成安装和自用；公网 IP 证书需要另行配置支持 IP 证书的 CA、验证与续期流程，不能把这个域名配置直接换成任意 IP 就视为完成。已有 IP HTTPS 入口的用户保留原证书代理，只更换它后面的工作台容器。

## 6. NAS 与局域网访问

- 飞牛等 NAS 的数据目录选在长期存储卷上，不要使用临时目录。Docker Compose 可以从 SSH 终端运行。
- 只在局域网使用时，可把工作台的端口行改为 `"NAS的局域网IP:8787:8787"`，通过这个地址访问。Gate 的 `127.0.0.1:18000:8000` 保持不变。
- 局域网 HTTP 连接不加密；不要把这个 HTTP 端口直接映射到公网。多人公网使用配置 HTTPS。
- 已有 NAS 反代或 FRP 时，沿用现有入口和证书，把流量转到工作台。若 HTTPS 在 NAS 终止，FRP 应透传 TLS 到该 HTTPS 服务；若在 VPS 终止，则由 VPS 的 HTTPS 服务转发到工作台。不要让两层代理都重复处理同一段 TLS。
- 从局域网地址切换到公网域名，浏览器会视为另一个站点。切换前导出工作台备份，在新地址登录后导入，旧地址的图库不会自动出现。

## 7. 日常更新、备份与回退

### 只更新工作台

保持现有站点地址和 Gate Key，先结束当前生成任务。在 `.env` 中把 `WORKBENCH_IMAGE` 改成要升级的版本，然后执行：

```sh
docker compose pull workbench
docker compose up -d --no-deps workbench
curl -fsS http://127.0.0.1:8787/api/health
```

这只更换工作台，不重启 Gate 或 Caddy。浏览器刷新后加载新界面；已打开的旧标签页不会自动换成新界面。刷新会清空当前上传的参考图和蒙版，长期图库、提示词及设置仍保留。

回退时，把 `WORKBENCH_IMAGE` 改回先前版本，再执行这两条 Compose 命令。用明确的版本标签比跟随 `beta` 更容易回退。需要跟随测试版时可以填写 `ghcr.io/kronosxup/nai-workbench:beta`。

### 备份 Gate

Gate 的数据在 `gate-data`；`SECRET_KEY` 未手工设置时，会自动生成并保存在其中。完整备份数据目录、`.env` 和 Compose 文件。最简单的一致性备份需要短暂停止 Gate，先让使用者结束任务：

```sh
mkdir -p backups
stamp=$(date +%Y%m%d-%H%M%S)
umask 077
git -C gate rev-parse HEAD > "backups/gate-$stamp.commit"
docker compose stop gate
tar -czf "backups/gate-$stamp.tar.gz" .env compose.yaml gate-data
docker compose start gate
```

先确认 `tar` 成功，再把这份文件当作可用备份；若备份失败，也要恢复 Gate 服务并处理磁盘空间或权限问题。备份含官方 Token、管理密码和数据库，应单独保管。

工作台图库不在这个备份里。每位用户需要在工作台设置中导出自己的浏览器备份；分卷备份要保留全部文件。HTTPS 的 `Caddyfile`、`compose.https.yaml`、`caddy-data`、`caddy-config` 也应单独备份。

### 更新 Gate

先完成上面的备份，并记住旧镜像标签。查看作者变更说明后，选定目标提交，不要直接覆盖自己的修改：

```sh
git -C gate fetch origin
git -C gate checkout 要升级的完整提交SHA
```

把 `.env` 的 `GATE_IMAGE` 改成一个新本地标签，例如 `nai-gate:你选定的短SHA`，然后执行：

```sh
docker compose build gate
docker compose up -d --no-deps gate
curl -fsS http://127.0.0.1:18000/healthz
```

再通过 SSH 隧道登录后台，检查已有 Key、额度和历史记录。数据库迁移会在 Gate 启动时进行，不要在更新时删除 `gate-data`。

### Gate 回退

如果新版本没有不兼容的数据迁移，可以将 `GATE_IMAGE` 改回保留的旧标签，用 `docker compose up -d --no-deps --no-build gate` 启动旧镜像。

若存在数据结构不兼容，需要停 Gate、保留当前数据副本，再恢复升级前的数据库和旧配置，配合旧镜像启动。**恢复旧数据库会丢失备份之后新增的 Key 和用量记录**；已有新请求时应先处理这部分记录，不能直接覆盖。不要把 `down -v` 或删除数据目录当作普通更新步骤。

## 8. 已经有 Gate，只加工作台

不使用上面的整套 `nai-stack`，直接使用工作台仓库自带配置：

```sh
git clone https://github.com/KronosXup/nai-workbench.git
cd nai-workbench
cp .env.gate.example .env
```

在 `.env` 中填写容器可访问的 Gate 地址。如果 Gate 在宿主机开放端口，可以使用：

```dotenv
WORKBENCH_GATE_URL=http://host.docker.internal:8000
WORKBENCH_IMAGE=ghcr.io/kronosxup/nai-workbench:v0.1.0-beta.4
```

Gate 只监听宿主机 `127.0.0.1` 时，上面的宿主机网关地址访问不到它。Gate 也是 Docker 容器时，优先让工作台加入 Gate 的现有网络：

```dotenv
WORKBENCH_GATE_URL=http://实际Gate服务名:8000
GATE_DOCKER_NETWORK=实际Gate网络名
WORKBENCH_IMAGE=ghcr.io/kronosxup/nai-workbench:v0.1.0-beta.4
```

网络名可通过 `docker network ls` 和 Gate 的 Compose 配置核对，不要默认照抄 `gate_default`。使用网络覆盖文件时，每次命令都带上它：

```sh
docker compose -f compose.gate.yaml -f compose.gate-network.yaml pull
docker compose -f compose.gate.yaml -f compose.gate-network.yaml up -d
```

不需要共享 Docker 网络时，只使用 `-f compose.gate.yaml`。该配置默认绑定 `127.0.0.1:8787`，HTTPS 入口按前面的原则配置。详细选项见 [Gate 连接模式](GATE-FRONTEND.md)。

## 9. 常见问题

| 现象 | 检查内容 |
|---|---|
| 拉镜像提示 unauthorized／denied | 镜像是公开的，先核对名称和网络；过期的 GHCR 登录也可能导致拒绝。可用新的空 Docker 配置目录匿名拉取，不必删除整份 Docker 凭据。 |
| 工作台无法连接 Gate | 地址要从容器内部可达；核对服务名、Docker 网络、Gate 端口和日志。`localhost` 指向当前容器。 |
| 后台输入密码后仍回登录页 | 核对 HTTP/HTTPS 与 `ADMIN_COOKIE_SECURE` 是否匹配。修改环境变量后要 `up -d` 重建容器，单纯 `restart` 不会载入新变量。 |
| 后台提示登录过于频繁 | 先修正密码或 Cookie 配置，等限流窗口结束再试，避免连续点击。 |
| 工作台能登录但 V5 不可用 | 检查 Key 模型范围、V5 次数、全站额度及上游账号能力。 |
| 图生图／局部重绘被拒绝 | 检查全局图生图开关、Key 图生图权限和 Anlas 权限是否都已开启。 |
| 导演工具或参考图报价不是 0 | 这些功能可能收费；以 Gate 实际结算为准，打开权限不等于免费。 |
| Key 几天不用就消失 | 上游默认开启闲置 Key 清理；本文显式设置 `KEY_INACTIVITY_DELETE_DAYS=0`。 |
| 生成有结果但中间没有预览 | 检查工作台流式开关、目标接口能力和反代响应缓冲。 |
| 更新后界面没变 | 刷新旧标签页，核对容器镜像版本；不要靠清空浏览器站点数据解决，那会删除本机图库。 |
| 换域名／浏览器／Key 后图库为空 | 图库按来源地址和 Key 隔离，需要从原环境导出，再导入新环境。 |
| 关闭页面后批量没有继续 | 批量队列由浏览器执行，需要保持页面打开；结果不确定时不会自动重试。 |

排查容器启动问题可用 `docker compose ps` 与 `docker compose logs --tail 100 gate workbench`。分享日志前检查并隐藏凭据，不要公开 `.env`、后台页面导出的敏感信息或数据库。

## 10. 验证范围和参考

本文的 Gate 配置名、权限和后台行为已按固定上游版本核对；Compose 示例做配置解析检查。工作台 beta.4 镜像已在现有 NAS 上部署并检查 HTTPS、健康与静态资源；这不等于对每种新服务器环境都做过整套安装。新 Gate 账号是否可用，仍需在自己的环境完成登录和必要的功能验证。

- [Gate README](https://github.com/fangchen2003/service-tools/blob/4b0ff693b3ed6aa4f2006162453d32783c011718/README.md)
- [Gate 环境变量示例](https://github.com/fangchen2003/service-tools/blob/4b0ff693b3ed6aa4f2006162453d32783c011718/.env.example)
- [工作台 Release](https://github.com/KronosXup/nai-workbench/releases/tag/v0.1.0-beta.4)
- [Gate 版本与接口要求](GATE-COMPATIBILITY.md)
