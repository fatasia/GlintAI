# ComfyUI 本地执行适配器

`@glintai/media` 的 `ComfyUIClient` 供 Node 调用方执行已有 API-format 工作流。它不替代模型注册表，也未接入 Studio 页面。

- 只连接调用方显式指定的 `127.0.0.1` 或 `[::1]` origin；不扫描端口，不接受远程服务或 DNS 主机名。
- 提交只发送一次。保存返回的 prompt ID，后续用 `status(id)` 恢复；提交断线时先查 ComfyUI 历史，不自动重投。
- `cancelQueued(id)` 只请求删除该排队项，返回 `delete-requested` 或 `not-queued`。任务可能同时进入运行状态，不承诺已停止，不调用全局 interrupt。
- 下载只访问同源 `/view`，默认 64 MiB、可配置至 512 MiB，禁止重定向和路径穿越。

## 最短调用

从自己安装的 ComfyUI 导出 **API format** JSON，而不是画布布局 JSON。确保工作流所需节点与模型已安装。

```ts
import { ComfyUIClient } from "@glintai/media";

const client = new ComfyUIClient("http://127.0.0.1:8188");
// workflow 为调用方读取的 API-format JSON；节点与输入名必须来自该工作流。
const promptId = await client.submit(workflow, [
  { nodeId: "6", input: "text", value: "晨光中的山谷" },
]);
// 调用方立即持久化 promptId；恢复进程无需再次 submit。
const task = await client.status(promptId);
if (task.state === "success" && task.outputs[0]) {
  const bytes = await client.download(task.outputs[0], { maxBytes: 20 * 1024 * 1024 });
  // 交由调用方现有素材导入/操作协议处理 bytes。
}
```

参数替换作用于副本，要求已存在的标量输入且类型一致；不重连节点边。成功历史只提取 `images/gifs/audio/videos` 中提供文件描述符的输出，自定义节点返回远程 URL 或内存结果不支持。状态 `unknown` 表示 queue/history 都未找到，可能是历史被清除，不等同失败或取消。

工作流是用户信任的本机执行配置，节点可读写本机资源；此适配器只校验 API 结构与输入映射，不是工作流沙箱。元数据和工作流上限为 2 MiB。所有网络操作支持 AbortSignal，并带默认超时。

## API 核验与验证范围

2026-11-03 核验官方 [HTTP 路由说明](https://docs.comfy.org/development/comfyui-server/comms_routes) 与 [API 示例](https://github.com/Comfy-Org/ComfyUI/blob/master/script_examples/websockets_api_example.py)：提交走 `/prompt`，恢复查 `/history/{prompt_id}` 与 `/queue`，文件用 `/view` 的 filename/subfolder/type 参数。本实现按接口独立编写，未引入上游代码或依赖。

测试启动隔离的真实本地 HTTP 服务，覆盖提交、恢复、队列状态、定向删除、错误、下载限额、重定向与 abort；未连接实际 ComfyUI、未加载模型、未生成媒体。实际节点兼容性与生成质量仍需用户自己的安装环境验收。


## CLI 与独立 Skill

先由用户启动自己的 ComfyUI。以下入口复用同一个适配器，不会自动启动服务、安装节点或选择模型。

```text
pnpm glint comfyui submit --endpoint=http://127.0.0.1:8188 --workflow=workflow-api.json --inputs=inputs.json --confirm-execute
pnpm glint comfyui status --endpoint=http://127.0.0.1:8188 --id=<promptId>
pnpm glint comfyui cancel --endpoint=http://127.0.0.1:8188 --id=<promptId>
pnpm glint comfyui download --endpoint=http://127.0.0.1:8188 --id=<promptId> --output-index=0 --out=result.png --max-bytes=20971520
```

`--inputs` 可省略；文件格式为 `[{"nodeId":"6","input":"text","value":"晨光中的山谷"}]`。workflow 与 inputs 只读取普通文件，各不超过 2 MiB。提交必须显式给出 `--confirm-execute`；Agent 应先向用户确认本地执行意图与工作流。endpoint 无默认值，每次明确传入 loopback origin。

命令 stdout 输出单行 JSON；成功退出 0，失败退出 2。提交响应丢失输出 `submission-unconfirmed` 和 `retryAutomatically:false`，保留用户输入并检查服务历史，不自动重投。收到 promptId 后由调用方立即持久化；重启后只用 status 查询。

下载先读取指定 prompt 的成功历史，index 是返回 outputs 数组的零基索引，不接受任意结果 URL/文件描述符。`--out` 使用独占创建，目标已存在则拒绝；不导入素材、不修改工程。下载失败后不自动重试或覆盖。

外部 Agent 从自己的工作目录运行同样命令：

```text
node <skill目录>/scripts/glint.mjs --root=<Glint仓库> comfyui status --endpoint=http://127.0.0.1:8188 --id=<promptId>
```

CLI 已用本地 HTTP fixture 与真实子进程路由测试；实际 ComfyUI 节点/模型与 Studio UI 接线仍未验收。

## 执行前检查节点依赖

```text
pnpm glint comfyui check --endpoint=http://127.0.0.1:8188 --workflow=workflow-api.json
```

库入口为 `await client.checkNodes(workflow, signal?)`，返回 `{ok, checked, available, missing}`。按唯一 `class_type` 去重并排序，最多检查 128 种节点、每个名称最多 256 字符；最多 4 个并发请求，全批共享 20 秒时限。沿用普通文件/2 MiB 限额、loopback、重定向拒绝和 AbortSignal 边界。

CLI 只输出 JSON：节点齐全退出 0，缺节点或检查错误退出 2。节点齐全不表示模型权重已安装、输入合法、显存足够或渲染质量合格。此检查不下载模型、不运行节点；不会隐式加入 submit，也不替代用户确认执行。

2026-11-03 根据官方 [路由文档](https://docs.comfy.org/development/comfyui-server/comms_routes) 与 [object_info 实现](https://github.com/Comfy-Org/ComfyUI/blob/master/server.py) 核验：GET `/object_info/{node_class}` 返回该类的元数据对象；空对象表示缺失，HTTP错误或畸形元数据不当作检查通过。每个类名编码为单个路径参数，不使用返回内容提供的新 URL。
