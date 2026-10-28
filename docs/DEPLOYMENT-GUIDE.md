# 安装 Gate 和 NAI 工作台

适用于装有 **Docker Compose v2 和 Git 的 Intel / AMD Linux 服务器或 NAS**。先通过 SSH 登录服务器，选择一个长期存放文件的目录。下面前三行在服务器上执行。

## 1. 启动安装向导

```sh
git clone https://github.com/KronosXup/nai-workbench.git
cd nai-workbench
bash deploy.sh
```

按自己的情况选择：

| 选择 | 需要填写 | 向导会做什么 |
|---|---|---|
| **1. 全新安装** | 自己设置的后台密码、NovelAI Token | 下载配套 Gate，生成配置并启动 Gate 和工作台 |
| **2. 已有 Gate** | Gate 连接地址 | 只启动工作台，沿用现有 Gate |

全新安装所需的 **Persistent API Token** 在 NovelAI 官网的 **User Settings → Account** 中获取。它不是账号密码，也不是稍后登录工作台的 Gate Key。向导输入密码和 Token 时不会显示文字。

已有 Gate 时，填写工作台容器可以访问的地址。例如 Gate 就在同一服务器并开放了 `8000` 端口，可填 `http://host.docker.internal:8000`。如果 Gate 只在 Docker 网络内开放，则填服务名地址（如 `http://gate:8000`），并在下一步填写它的 Docker 网络名。连接不通可查[连接说明](GATE-FRONTEND.md)。

**看到“工作台已启动”后继续下一步。** 下载失败时可重新运行向导，它会沿用已有配置。配置和 Gate 数据保存在安装目录中，请保留这个目录。

## 2. 打开页面

先在**自己电脑**另开一个终端，执行下面这行，把 `用户名@服务器地址` 换成刚才 SSH 使用的登录地址。这个终端保持打开。

```sh
ssh -N -L 18000:127.0.0.1:18000 -L 8787:127.0.0.1:8787 用户名@服务器地址
```

1. 全新安装：浏览器打开 **http://127.0.0.1:18000/admin**，用刚设置的密码登录，创建一个 Gate Key。已有 Gate 的用户直接使用原来的 Key。
2. 浏览器打开 **http://127.0.0.1:8787**，填入 **Gate Key**，进入绘图页。

这条 SSH 命令把服务器页面安全地转到自己电脑，不用开放后台端口。**只安装工作台时，可以删去命令中的 `-L 18000:127.0.0.1:18000`。**

创建 Key 时按需要开放模型、图生图和 Anlas 权限，并设置额度。图生图需要对应权限，部分工具会收费；允许调用不等于免费。

## 3. 让其他人通过网址使用（可选）

配套全新安装可以运行：

```sh
bash deploy.sh https
```

按提示填写域名即可。运行前需将域名解析到服务器，并放行 TCP **80、443**；这两个端口不能已被其他服务占用。向导会启动 Caddy 申请和续签证书，之后大家通过 `https://你的域名` 访问工作台，后台仍通过上面的 SSH 方式访问。

使用阿里云中国内地服务器时，公开网站需先完成备案；香港或海外节点不需要这项大陆 ICP 备案。直接使用 IP 或配置 HTTPS 不能代替备案，详见[阿里云说明](https://www.alibabacloud.com/help/en/icp-filing/basic-icp-service/product-overview/icp-filing-requirements-for-a-regular-website)。

**已有反向代理，或选择了“只安装工作台”**：沿用现有 HTTPS 入口，转发到服务器的 `127.0.0.1:8787`。反代也在 Docker 容器里时，使用共同网络中的工作台服务名，详见[连接说明](GATE-FRONTEND.md)。NAS 穿透、纯 IP 证书等特殊环境见[维护说明](DEPLOYMENT-MAINTENANCE.md#nas-与局域网访问)。

换访问地址前，先在工作台设置中导出图库备份，再到新地址导入。浏览器不会自动搬运旧地址下的数据。

## 以后怎么更新

等正在生成的任务结束，在服务器的 `nai-workbench` 目录执行：

```sh
bash deploy.sh update
```

确认后更新到当前发布的 `beta` 镜像，**只更新工作台，不更新 Gate**。完成后刷新网页。也可以指定版本，例如 `bash deploy.sh update v0.1.0-beta.5`。

向导会保留更新前的配置；备份、回退和 Gate 更新见[维护说明](DEPLOYMENT-MAINTENANCE.md)。不要删除数据目录或清空浏览器站点数据来更新。

## 遇到问题

- **提示没有 Docker / 无权限**：先在服务器或 NAS 安装、启动 Docker，并让当前登录账号能够使用它。
- **无法下载镜像或 Gate**：检查服务器到 GitHub、GHCR 的网络，恢复后重跑向导。
- **工作台打开了但不能登录**：核对 Gate 地址和 Key；官方 Token 不能直接用来登录工作台。
- **ARM 设备或自定义部署**：见[手动部署说明](GATE-FRONTEND.md)。

配套首次安装使用工作台 `v0.1.0-beta.5`，Gate 从原作者默认分支下载安装当时的最新源码，实际提交号会写入 `.env` 的 `GATE_IMAGE`。再次运行向导会沿用已有 Gate 源码，不会自动升级它。版本与接口要求见[兼容说明](GATE-COMPATIBILITY.md)。
