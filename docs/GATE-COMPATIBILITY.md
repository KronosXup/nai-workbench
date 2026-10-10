# Gate 版本与接口

本项目连接 [fangchen2003/service-tools](https://github.com/fangchen2003/service-tools) 的 NAI Gate。
首版所需的路由和响应字段已按上游提交 [`b81959c`](https://github.com/fangchen2003/service-tools/tree/b81959c0cf5533ca5fc3071dff2e8926e9b12629) 核对。

| 工作台用途 | Gate 接口 |
|---|---|
| 验证 Key、读取权限 | `GET /user/information` |
| 显示积分与 V5 额度 | `GET /user/subscription` |
| 显示 V4.5 及以下每日免费图剩余 | `GET /v1/me` |
| 显示服务器排队状态 | `GET /queue-status` |
| 生图与流式预览 | `POST /ai/generate-image`、`POST /ai/generate-image-stream` |
| 编码 Vibe | `POST /ai/encode-vibe` |
| 放大、导演工具 | `POST /ai/upscale`、`POST /ai/augment-image` |
| 提示词建议 | `GET /ai/generate-image/suggest-tags` |

适配服务会读取订阅响应中的 `naiGate` 扩展字段，包括 Anlas 余额、月限额和 V5 每日额度；排队状态使用 `global` 与 `image_cooldown_remaining`。仅提供 OpenAI 兼容接口的服务无法替代这些接口。

每日免费图剩余使用 `/v1/me` 的 `today.daily_images` 和 `today.legacy_free_images_today`，不使用包含付费图和 V5 的总图片数。上限为 0 表示不限；旧版 Gate 缺少接口或字段时显示“暂不可用”，其他功能仍可使用。此查询只读取 Gate 本地记录。

## 费用与功能

工作台显示参数估算，Gate 负责权限判断、参数限制和实际记账。Gate 的[图片计费与兼容性改动 PR #2](https://github.com/fangchen2003/service-tools/pull/2) 已于 2026-09-26 合并，上游提交为 `4b0ff693b3ed6aa4f2006162453d32783c011718`。这批改动不是上述基础接口的前提，但不同 Gate 版本的费用计算可能不同。[完整部署教程](DEPLOYMENT-GUIDE.md)按该上游提交编写。

图生图、局部重绘、参考图和导演工具还受 Gate 配置、Key 权限、模型及官方账号能力限制。工作台不能绕过这些限制。

## 2026-10-10 上游兼容核对

已对比上游 `5940e0e` 至 `e8f48cad94056fd6a02993eb0275a8b4a402b126` 的图片准入、累计图片数和 V5 Medium 自动路由改动。

- `v5LeftToday` 可包含两位小数，工作台按 V5 单位显示；Medium 默认扣减 0.60 单位，但倍率由 Gate 配置决定。工作台保留所选模型和参数，由 Gate 决定实际路由。报价未取得路由和倍率，仍按原模型估算并明确提示，不能作为实际扣额或最终模型的证明。
- `/queue-status` 的 `global.concurrency` 可为 0，工作台正常显示此状态；队列快照不作为自动重试依据。
- 三种新增的图片任务、预算核对、上游图片任务排队超时，均在派发前发生。仅按完整固定消息识别为可等待重试；普通上游 429、流中错误或结果未知仍暂停，不自动重发。
- 累计图片数和运行时准入设置属于 Gate 管理页，工作台无需复制管理入口。

以上经过源码对比和离线模拟验证；未升级 Gate，也未进行新版本生产生图验收。

## 首次连接检查

先确认可以登录、读取模型与额度，再检查报价和队列状态。真实生成会按 Gate 规则计费，可用自己的常用参数验证。仓库离线检查使用模拟响应，不能替代目标 Gate 环境的实际验证。
