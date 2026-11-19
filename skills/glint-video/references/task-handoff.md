# 在外部 Agent 接续任务

`tasks` 连接已运行的 Glint 服务，查询已有渲染、媒体和 ComfyUI 任务；不创建新任务，也不重新提交模型。

服务地址使用现有 `GLINT_CONTAINER_ENDPOINT`（可带挂载路径），访问令牌使用 `GLINT_ACCESS_TOKEN`。令牌只在进程环境中配置，不放命令行、任务文件或 MCP 参数中。HTTP 仅允许 loopback，远程服务须 HTTPS。

```sh
node skills/glint-video/scripts/glint.mjs --root=<runtime> tasks list
node skills/glint-video/scripts/glint.mjs --root=<runtime> tasks status --family=media --id=<task-id>
node skills/glint-video/scripts/glint.mjs --root=<runtime> tasks cancel --family=comfyui --id=<task-id> --confirm
```

源仓库也可使用 `pnpm glint tasks ...`。MCP 对应 `glint_tasks_list`、`glint_tasks_status`、`glint_tasks_cancel`；取消参数必须有 `confirm: true`，仅在用户明确同意后传入。endpoint/token 不允许由模型工具参数覆盖。

- list 仅返回白名单元数据，不含提示词、工作流、凭据或供应商 URL。`truncated` 与 `unreadable` 应保留，列表不是完整任务历史。
- status 先查列表，再按 family/id 查询原状态路由。没有列出的 ID、不带 taskId 的请求预留记录，回原创作入口及其请求回执恢复，不猜任务 ID、不重新 submit。
- cancel 前必须确认；未确认零写。`cancelRequested` 表示取消已请求；Comfy 的 `deleteRequested` 只请求删除排队项，`notQueued` 不表示执行已停止。取消不保证退款。
- cost 的 amount/unit 原样保留；未知为 null，不当作 0、不推测人民币或换算汇率。
- 返回 JSON，失败非零；不会自动重试写请求。状态里的 result 只允许服务本地资产路径，下载/导入仍走已有入口。
