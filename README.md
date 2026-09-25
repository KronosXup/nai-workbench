# NAI 工作台

连接 [NAI Gate](https://github.com/fangchen2003/service-tools) 的中文绘图前端，提供绘图、参考图、导演工具和多组提示词批量生成。

浏览器通过随项目提供的轻量适配服务连接 Gate。用户使用 Gate 分配的 Key 登录，官方账号与计费由 Gate 管理。当前为测试版，部署前请先阅读 [Gate 版本要求](docs/GATE-COMPATIBILITY.md)。

## 功能

- 中文绘图界面，支持文生图、图生图、局部重绘和流式预览。
- Vibe、精准参考、放大及导演工具，按模型与 Gate 能力启用。
- 五组提示词批量生成，可共用或分别设置画师、质量和负面提示词。
- 本地画布、图片参数导入、提示词计数、图库与备份。

## 快速部署

需要 Docker Compose v2 和一个可用的 Gate 服务，两者加入同一个 Docker 网络。

```sh
git clone https://github.com/KronosXup/nai-workbench.git
cd nai-workbench
cp .env.gate.example .env
# 编辑 .env：填写 Gate 在 Docker 网络中的地址与网络名
docker compose --env-file .env -f compose.gate.yaml config
docker compose --env-file .env -f compose.gate.yaml up --build -d
```

打开 `http://127.0.0.1:8787`，输入 Gate Key。首次构建需要访问 Docker 镜像仓库、npm 和 PyPI；不需要预先构建前端或准备其他项目的镜像。

公网使用请配置 HTTPS 反向代理。网络、端口和容器设置见[部署说明](docs/GATE-FRONTEND.md)。

## 使用说明

- 批量任务由浏览器逐张提交，请保持页面打开。刷新、关闭或断网后，在途任务无法恢复；明确的限流拒绝会等待后继续，结果不确定时暂停。
- 流式预览和提示词标签建议可在设置页开关，选项保存在当前 Key 的本机草稿中。
- 图片和草稿保存在当前浏览器的 IndexedDB。换浏览器、站点地址或 Gate Key 前，请先导出备份；服务端没有共享图库。
- 图库较大时备份会分成多个 JSON 文件。请保存全部文件，回导时一次选中同一组文件。
- 费用显示为参数估算，实际扣费、权限和免费额度由 Gate 决定。
- 本项目通过 Gate 使用 NovelAI，暂不支持直接填写官方 Key。

## 开发与检查

本地运行、测试和发布打包见[开发说明](docs/DEVELOPMENT.md)。检查使用模拟上游，不调用 NovelAI 生图。

## 来源与许可

本项目采用 [MIT 许可证](LICENSE)，与 NovelAI 无官方关联。第三方依赖、字体和 tokenizer 分别遵循各自的许可，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
