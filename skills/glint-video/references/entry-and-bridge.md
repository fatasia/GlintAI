# Glint Skill 与产品入口桥接

这份 reference 规定 Skill 与产品不是上下游导入导出关系，而是两个平等入口。

这里的 IntentRecord、route、TaskReceipt 等为目标规格中的概念，不是可直接调用的同名 CLI/API。实际可执行命令以 SKILL.md 的命令表和 CLI 帮助为准；工程使用现有 SceneScript / NleProject，协作修改使用 session 协议。

独立安装时完整复制 `glint-video/`，在任意 Agent 工作目录运行 `node <skill目录>/scripts/glint.mjs --root=<已安装的Glint仓库> <命令> ...`。启动器复用同一 CLI，保留调用者的相对输入输出路径，不要求桌面 UI、不再实现一套模型客户端或渲染器。

`--root` 也接受含 `app/build.json`、`app/cli/glint.mjs` 和 `app/studio` 的便携包根目录，不是 `app` 子目录。便携模式直接运行已编译 CLI，无需 pnpm、tsx 或源码；入口和浏览器资源位置固定到选中的包，忽略其他安装遗留的入口变量。先用 `--runtime-check` 确认 `runtime` 为 `source` 或 `portable`，再执行命令。只使用自己信任的运行时：布局与 build 标识检查不是签名验证。轻量包需系统 Node.js 22+；完整包可用包内 `node.exe` 启动 Skill。具体命令是否存在取决于该包版本，旧包不会自动获得新命令。

## 统一作品：现在可用的连接方式

已有统一作品使用 `container` 命令，不使用下面旧文件模式的 `session set/apply`。两者不是同一存储入口。

1. 启动或连接已有 Glint 服务；无需打开网页。将服务根写入 `GLINT_CONTAINER_ENDPOINT`（含部署子路径，如 `http://127.0.0.1:4175/studio/`）。远程服务必须用 HTTPS；公网鉴权令牌仅通过进程环境 `GLINT_ACCESS_TOKEN` 提供，不放进命令参数、MCP 参数或工程。
2. 不知道作品 ID 时先 `container list --limit=20`，有 nextCursor 时用 `--cursor=<nextCursor>` 继续；按 projectId 选中原作品，再用 `container snapshot --id=work` 读取共享 revision、对象 ID、currentVersionId 与当前 payload。只改明确目标，保留文档原 ID。
3. 准备原 HTTP 请求结构的 `transaction.json`：顶层 `projectId`、`transaction`、`changes`；transaction 包含稳定 `id`、刚读取的 `baseRevision`、`actor:"skill"`、`scope:{}` 与 `intent`；每项 changes 包含 `objectId`、新的 `versionId` 和完整文档 `payload`。
4. `container append --request=transaction.json`。保存后检查 `receipt.stage`、事务 ID 和回读文档；`verified` 只表示保存回读成功，不表示媒体渲染或审美验收通过。
5. 冲突时保留草稿，重新读取共享版本并重新评估修改；不要自动覆盖。断网导致结果不确定时，先 snapshot 核对，必要时使用**相同事务 ID、版本 ID 和原请求内容**重试；不要生成新 ID 盲目重投。

例如在外部 Agent 目录运行：

```text
node <skill目录>/scripts/glint.mjs --root=<Glint仓库> container list --limit=20
node <skill目录>/scripts/glint.mjs --root=<Glint仓库> container snapshot --id=work
node <skill目录>/scripts/glint.mjs --root=<Glint仓库> container append --request=transaction.json
```

`container undo|redo --request=history.json` 的请求包含 `projectId`、稳定 `transactionId`、当前 `baseRevision`、`actor:"skill"`。这是整个作品的共享历史，可能撤销另一个视图的修改，不是当前文档的本地撤销。

`container open --request=open.json` 用于导入作品容器，请求包含 `projectId`、`project`、`createOnly:true`；旧文件先用 `project-migrate` 显式迁移。它不增加文档对象、不批准角色素材，也不把分镜拍平成剪辑。

MCP 提供 `glint_container_list/snapshot/open/append/undo/redo` 六个工具，连接目标和令牌只读 MCP 进程环境。append 参数使用 `projectId`、`transactionId`、`baseRevision`、`changes` 和可选 `intent`；actor 固定为 skill。不要把已有文件型 `glint_apply` 当作容器修改入口。

`glint_container_list` 只接受可选 limit（1..50）和 cursor。列表只返回作品 ID、revision、短标题、分镜/剪辑文档数和可选 firstDocumentId，不含文档或归档；firstDocumentId 是容器对象 ID，不是原 payload.id。列表可能在翻页间变化，编辑前必须重新 snapshot。找回作品不新建副本，也不扫描 Agent 本机另建项目库。

服务不可达时停止提交并保留草稿。独立 Skill 仍需要已安装的 Glint 运行时；容器协作另外需要同一个服务端，不会自动启动服务或下载依赖。

## 创作与验证规则

1. 先识别工程状态：新建、已有工程、任务恢复、冲突待处理。
2. 新建请求记录目标意图，再按交付物选择一次工作流；`IntentRecord` 是规格名，不是现行 API。
3. 已有工程的明确编辑直接进入 route，不重复问意图。
4. 修改使用对应模式的事务接口，不直接覆盖服务工程文件。
5. 保存回执与媒体验证分开报告：容器 `verified` 只表示保存回读；成片仍须 lint/check、审帧和交付检查。

## 旧文件模式与尚未实现的桥接

旧 SceneScript 文件模式可使用原有 `session` / `glint_apply`，其文件与会话 journal 不属于统一作品容器。不要把旧命令的本地保存写成容器服务已经保存。

规格中的跨 Agent 选区、播放头及任务现场自动恢复尚未全部接线。当前容器页面按服务 revision 读取文档；不保证外部修改自动切换当前选区或播放位置，也没有断网后自动合并本地 journal 的路径。

## 最短工作流

```text
inspect → route → plan → apply transaction → frame readback → lint/check → render → receipt
```

## 相关合同

- `ProjectDocument`
- `EditTransaction`
- `CapabilityManifest`
- `TaskReceipt`

## 参考


## NLE 导出运动模糊（CLI）

`glint nle-render --project=nle.json --assets=media --out=new.mp4 --motion-samples=4 --shutter-angle=180`

只对导出启用，原工程不变。默认1样本保持原截图；2/4/8在同一NLE帧函数中逐次seek媒体并积分，约需N倍截图/解码。MG叠加与生成视频同样采样；源视频有限帧率不会补造中间运动。曝光向后取样，夹在最近片段起止切点，不借前镜像素。

启用时最多720p（长边1280）、2400样本帧、1105920000样本像素、5分钟，超过即拒绝；输出/封面需新路径。透明WebM仍只接受原文字/音频范围，不开放图片/视频。CLI结果记录样本、角度与成帧摘要；Ctrl+C停止本任务。native、Remotion、Web按钮、4K运动模糊、预演控制图未支持；不要把参数放到其他命令。
