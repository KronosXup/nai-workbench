# 部署后的维护与排错

第一次安装请看[部署教程](DEPLOYMENT-GUIDE.md)。以下命令对应教程的 `nai-workbench/deploy/stack` 目录；已有 Gate、只安装工作台的用户请看 [Gate 连接说明](GATE-FRONTEND.md)。

## SSH 提示本地端口已占用

在自己电脑执行隧道命令时，若提示 `Address already in use`，可以只修改 `-L` 后的第一个端口号。例如改成：

```sh
ssh -N -L 18001:127.0.0.1:18000 -L 8788:127.0.0.1:8787 用户名@服务器地址
```

然后在自己电脑访问 `http://127.0.0.1:18001/admin` 和 `http://127.0.0.1:8788`。服务器配置不需要跟着修改。

## NAS 与局域网访问

- 飞牛等 NAS 的数据目录选在长期存储卷上，不要使用临时目录。Docker Compose 可以从 SSH 终端运行。
- 只在局域网使用时，可把工作台的端口行改为 `"NAS的局域网IP:8787:8787"`，通过这个地址访问。Gate 的 `127.0.0.1:18000:8000` 保持不变。
- 局域网 HTTP 连接不加密；不要把这个 HTTP 端口直接映射到公网。多人公网使用配置 HTTPS。
- 已有 NAS 反代或 FRP 时，沿用现有入口和证书，把流量转到工作台。若 HTTPS 在 NAS 终止，FRP 应透传 TLS 到该 HTTPS 服务；若在 VPS 终止，则由 VPS 的 HTTPS 服务转发到工作台。不要让两层代理都重复处理同一段 TLS。
- 从局域网地址切换到公网域名，浏览器会视为另一个站点。切换前导出工作台备份，在新地址登录后导入，旧地址的图库不会自动出现。


## 日常更新、备份与回退

### 只更新工作台

使用安装向导的用户，在仓库根目录运行 `bash deploy.sh update`，或指定版本 `bash deploy.sh update v0.1.0-beta.4`。向导只更新工作台，保留更新前的 `.env.before-update`；这个文件含凭据，不要分享。下载失败不会改配置；启动失败会恢复配置，但仍需检查容器是否正常。它不会自动更新 Gate。

手动部署的用户：保持现有站点地址和 Gate Key，先结束当前生成任务。在 `.env` 中把 `WORKBENCH_IMAGE` 改成要升级的版本，然后执行：

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

先完成本页的 Gate 备份，并记住旧镜像标签。查看作者变更说明后，选定目标提交，不要直接覆盖自己的修改：

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


## 常见问题

| 现象 | 检查内容 |
|---|---|
| 拉镜像提示 unauthorized／denied | 镜像是公开的，先核对名称和网络；过期的 GHCR 登录也可能导致拒绝。可用新的空 Docker 配置目录匿名拉取，不必删除整份 Docker 凭据。 |
| 工作台无法连接 Gate | 地址要从容器内部可达；核对服务名、Docker 网络、Gate 端口和日志。`localhost` 指向当前容器。 |
| 后台输入密码后仍回登录页 | 核对 HTTP/HTTPS 与 `ADMIN_COOKIE_SECURE` 是否匹配。修改环境变量后要 `up -d` 重建容器，单纯 `restart` 不会载入新变量。 |
| 后台提示登录过于频繁 | 先修正密码或 Cookie 配置，等限流窗口结束再试，避免连续点击。 |
| 工作台能登录但 V5 不可用 | 检查 Key 模型范围、V5 次数、全站额度及上游账号能力。 |
| 图生图／局部重绘被拒绝 | 检查全局图生图开关、Key 图生图权限和 Anlas 权限是否都已开启。 |
| 导演工具或参考图报价不是 0 | 这些功能可能收费；以 Gate 实际结算为准，打开权限不等于免费。 |
| Key 几天不用就消失 | 上游默认开启闲置 Key 清理；配套模板设置 `KEY_INACTIVITY_DELETE_DAYS=0`。 |
| 生成有结果但中间没有预览 | 检查工作台流式开关、目标接口能力和反代响应缓冲。 |
| 更新后界面没变 | 刷新旧标签页，核对容器镜像版本；不要靠清空浏览器站点数据解决，那会删除本机图库。 |
| 换域名／浏览器／Key 后图库为空 | 图库按来源地址和 Key 隔离，需要从原环境导出，再导入新环境。 |
| 关闭页面后批量没有继续 | 批量队列由浏览器执行，需要保持页面打开；结果不确定时不会自动重试。 |

排查容器启动问题可用 `docker compose ps` 与 `docker compose logs --tail 100 gate workbench`。分享日志前检查并隐藏凭据，不要公开 `.env`、后台页面导出的敏感信息或数据库。


## 验证范围和参考

配套模板的 Gate 配置名、权限和后台行为已按固定上游版本核对；Compose 示例做配置解析检查。工作台 beta.4 镜像已在现有 NAS 上部署并检查 HTTPS、健康与静态资源；这不等于对每种新服务器环境都做过整套安装。新 Gate 账号是否可用，仍需在自己的环境完成登录和必要的功能验证。

- [Gate README](https://github.com/fangchen2003/service-tools/blob/4b0ff693b3ed6aa4f2006162453d32783c011718/README.md)
- [Gate 环境变量示例](https://github.com/fangchen2003/service-tools/blob/4b0ff693b3ed6aa4f2006162453d32783c011718/.env.example)
- [工作台 Release](https://github.com/KronosXup/nai-workbench/releases/tag/v0.1.0-beta.4)
- [Gate 版本与接口要求](GATE-COMPATIBILITY.md)
