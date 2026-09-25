# Gate 版本与接口

本项目连接 [fangchen2003/service-tools](https://github.com/fangchen2003/service-tools) 的 NAI Gate。
首版所需的路由和响应字段已按上游提交 [`b81959c`](https://github.com/fangchen2003/service-tools/tree/b81959c0cf5533ca5fc3071dff2e8926e9b12629) 核对。

| 工作台用途 | Gate 接口 |
|---|---|
| 验证 Key、读取权限 | `GET /user/information` |
| 显示积分与 V5 额度 | `GET /user/subscription` |
| 显示服务器排队状态 | `GET /queue-status` |
| 生图与流式预览 | `POST /ai/generate-image`、`POST /ai/generate-image-stream` |
| 编码 Vibe | `POST /ai/encode-vibe` |
| 放大、导演工具 | `POST /ai/upscale`、`POST /ai/augment-image` |
| 提示词建议 | `GET /ai/generate-image/suggest-tags` |

适配服务会读取订阅响应中的 `naiGate` 扩展字段，包括 Anlas 余额、月限额和 V5 每日额度；排队状态使用 `global` 与 `image_cooldown_remaining`。仅提供 OpenAI 兼容接口的服务无法替代这些接口。

## 费用与功能

工作台显示参数估算，Gate 负责权限判断、参数限制和实际记账。Gate 的[图片计费与兼容性改动 PR #2](https://github.com/fangchen2003/service-tools/pull/2) 在本版发布时尚未合并；它不是上述基础接口的前提。不同 Gate 版本的费用计算可能不同，升级时请同时查看 Gate 的变更说明。

图生图、局部重绘、参考图和导演工具还受 Gate 配置、Key 权限、模型及官方账号能力限制。工作台不能绕过这些限制。

## 首次连接检查

先确认可以登录、读取模型与额度，再检查报价和队列状态。真实生成会按 Gate 规则计费，可用自己的常用参数验证。仓库离线检查使用模拟响应，不能替代目标 Gate 环境的实际验证。
