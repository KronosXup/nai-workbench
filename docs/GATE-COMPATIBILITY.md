# Gate 版本与接口

本项目连接 [fangchen2003/service-tools](https://github.com/fangchen2003/service-tools) 的 NAI Gate。
首版所需的路由和响应字段已按上游提交 [`b81959c`](https://github.com/fangchen2003/service-tools/tree/b81959c0cf5533ca5fc3071dff2e8926e9b12629) 核对。
当前代码要求 Gate 提供下面的计价参数报价接口；工作台与 Gate 需一起升级，升级后刷新已有页面。旧的完整图片 `payload` 报价格式不再接受，工作台不保留另一套本地费率公式。
`v0.1.0-beta.10` 的配套 Gate 源码为 [`2f81167`](https://github.com/KronosXup/service-tools/commit/2f81167e52c946cce4740b9d890fc3b44c00dba4)；升级顺序见[维护文档](DEPLOYMENT-MAINTENANCE.md#计价参数报价版本的配套升级)。

| 工作台用途 | Gate 接口 |
|---|---|
| 验证 Key、读取权限 | `GET /user/information` |
| 只读鉴权并取得费用 | `POST /v1/image/quote` |
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

工作台的 `/api/quote` 只向 Gate 发送模型、操作和计价参数，由 Gate 统一返回费用、参数调整及 Medium 路由。生成按钮、工具栏、导演工具和费用确认均使用该结果；接口不可用或返回无效价格时显示错误，不回退到本地估算。浏览器按原图、模型及信息提取值去重待编码 Vibe，只传 `pending_vibe_encoding_count`；参考图只传数量。报价不上传图片、蒙版、编码数据或提示词，也不解码或缩放图片。

报价请求最多 4 KiB，顶层仅接受 `operation`、`model`、`parameters`。例如：

```json
{"operation":"generate-image","model":"nai-diffusion-5-full","parameters":{"mode":"generate","width":832,"height":1216,"steps":23,"n_samples":1,"vibe_count":0,"precise_count":0,"pending_vibe_encoding_count":0}}
```

生成操作的 `mode` 为 `generate`、`img2img` 或 `inpaint`，按需附带 `strength`、`inpaint_strength`、`sm`、`sm_dyn`、`upscaled_enhance` 和 `has_controlnet`。放大使用 `operation=upscale` 与源图宽高；导演工具使用 `augment-image`、源图宽高和 `req_type`；单次 Vibe 编码使用 `encode-vibe` 和空 `parameters`。重绘模型映射由适配层按实际执行规则处理。

确认后的 `cost_limit` 随任务保留并传给 Gate；单次编码另用 `encoding_cost_limit`。正式执行才上传真图并校验图片、尺寸和参考数据，再按同一规则核算费用。低报计价参数不能绕过执行检查：实际费用超过已确认上限时，Gate 返回 409，工作台显示重新报价提示并停止该任务，不自动扩大费用或重试。Max 使用规范化源尺寸加 `upscaled_enhance=true`，显示尺寸从报价的 `output_size` 取得。

报价不调用真实 NAI；官方账号的额度可用性在实际派发前复核。Gate 的历史[图片计费与兼容性改动 PR #2](https://github.com/fangchen2003/service-tools/pull/2) 已于 2026-09-26 合并；新增报价接口与 Max 支持不能仅凭这个历史版本判断，应按目标实例接口验收。

图生图、局部重绘、参考图和导演工具还受 Gate 配置、Key 权限、模型及官方账号能力限制。工作台不能绕过这些限制。

V5 Full 的 Effort 切换使用 `nai-diffusion-5-full` / `nai-diffusion-5-full-medium`；局部重绘由适配层追加 `-inpainting`。Medium 固定 14 步、Euler Ancestral、Heavy 负面预设，High 草稿值保留以便切回。模型菜单将两者显示为同一个 V5 Full 家族。High 仍受 Gate 的免费 Key 自动 Medium 策略约束，报价确认自动切换时页面会提示。

## 2026-10-10 上游兼容核对

已对比上游 `5940e0e` 至 `e8f48cad94056fd6a02993eb0275a8b4a402b126` 的图片准入、累计图片数和 V5 Medium 自动路由改动。

- `v5LeftToday` 可包含两位小数，工作台按 V5 单位显示；Medium 默认扣减 0.60 单位，但倍率由 Gate 配置决定。工作台保留所选模型和参数，由 Gate 决定实际路由。2026-10-28 起报价也读取 Gate 的路由与倍率，不再按原模型单独估算。
- `/queue-status` 的 `global.concurrency` 可为 0，工作台正常显示此状态；队列快照不作为自动重试依据。
- 三种新增的图片任务、预算核对、上游图片任务排队超时，均在派发前发生。仅按完整固定消息识别为可等待重试；普通上游 429、流中错误或结果未知仍暂停，不自动重发。
- 累计图片数和运行时准入设置属于 Gate 管理页，工作台无需复制管理入口。

以上经过源码对比和离线模拟验证；未升级 Gate，也未进行新版本生产生图验收。

## 首次连接检查

先确认可以登录、读取模型与额度，再检查报价和队列状态。真实生成会按 Gate 规则计费，可用自己的常用参数验证。仓库离线检查使用模拟响应，不能替代目标 Gate 环境的实际验证。
