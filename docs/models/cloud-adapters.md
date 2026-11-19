# fal / Replicate 执行适配器

`FalClient` 与 `ReplicateClient` 供 Node 调用方执行用户已确认的生成请求。它们是执行层，不是模型目录；当前未接入产品配置、报价、任务账本或 Studio UI。

- 提交必须传 `confirmExecute: true`，每次只发一个请求，不自动重试。网络失败或回执解析失败时，调用方保留输入并先检查供应商控制台。
- 保存供应商 ID；fal 还需保存模型路径。进程恢复只查询已有 ID，不重新提交。
- API 凭据只发固定供应商 origin，不接受响应中的轮询/取消 URL，不跟随 API 重定向。
- 下载复用公共 HTTPS、DNS 固定和 10 MiB 限制，不附带 API 凭据；取消不代表已停止执行或免除费用。

## 用法

```ts
import { FalClient, ReplicateClient, downloadCloudOutput } from "@glintai/media";

const fal = new FalClient(process.env.FAL_KEY!);
const submitted = await fal.submit("fal-ai/flux/schnell", { prompt: "晨光中的山谷" }, { confirmExecute: true });
// 先持久化 submitted.model 和 submitted.requestId。
const status = await fal.status(submitted.model, submitted.requestId);
if (status.state === "completed") {
  const result = await fal.result(submitted.model, submitted.requestId);
  // 按该模型输出 schema 选取媒体 URL，再交给公共下载边界。
  // await downloadCloudOutput(selectedMediaUrl);
}

const replicate = new ReplicateClient(process.env.REPLICATE_API_TOKEN!);
// pinnedVersion 是用户选择的 64 位十六进制模型版本。
const prediction = await replicate.submit({ version: pinnedVersion }, { prompt: "山谷" }, { confirmExecute: true });
// 官方模型也可用 { model: "owner/name" }；不支持 deployment 路由。
const resumed = await replicate.status(prediction.predictionId);
```

两家都有 `status`、`result`、`cancel`；不内置循环等待或重试。成功结果保留模型特定 JSON，调用方按 schema 提取输出 URL。`result` 拒绝未完成、失败与未知状态。输出 URL 会过期，应在需要保留时下载，不把 API 回执当作成片质量通过。

## 协议与边界

2026-11-03 核验官方 [fal 队列文档](https://fal.ai/docs/documentation/model-apis/inference/queue)：提交用完整模型路径，状态/结果/取消只使用 owner/app 前两段。[状态 API](https://fal.ai/docs/api-reference/inference-api/queue/status) 的完成状态只标记 completed，仍可能是失败或取消；仅成功读取结果且结果无 error 才标记 success。取消分别返回 `cancelled-queued`、`requested`、`already-completed`、`not-found`；`requested` 不保证运行代码停止。

[Replicate HTTP API](https://replicate.com/docs/reference/http) 支持固定版本和官方模型预测。适配器将 `starting/processing/succeeded/failed/canceled` 映射为 `pending/running/success/failed/cancelled`，取消返回实际供应商状态，不将请求成功等同任务已取消。

每次 API 请求体上限 2 MiB，响应上限 4 MiB；默认超时 30 秒，可指定 1–60000 毫秒，支持 AbortSignal。错误只给供应商、分类和 HTTP 状态，不输出原始响应或 API 凭据。网络注入参数仅供受信任宿主测试，不是模型输入或产品 endpoint 配置。

输出下载沿用现有 `fetchPublicAsset`：HTTPS、公共地址校验、DNS pinning、10 MiB；重定向逐跳校验，与拒绝任何重定向的凭据 API 请求不同。不要把凭据嵌入结果 URL。

验证使用注入网络边界，覆盖序列化、异步恢复、错误、定向取消、身份及下载调用边界；没有调用真实供应商、没有费用或真实模型结果。价格、取消计费和模型输入兼容性仍由后续产品接线及实际服务验收确认。
