# 资料讲解配方

用同一 Glint CLI 把本地 Markdown 变成可编辑分镜，再按已确认计划执行。首版仅接本地原生画面；没有旁白音频，默认不会自动生成配音。

```sh
pnpm glint recipe plan --source=brief.md --out=explainer-run --visual=mg --voice=existing
# 查看 explainer-run/project.json 和命令返回的计划、报价范围及 planDigest。
pnpm glint recipe approve --dir=explainer-run --digest=<planDigest>
pnpm glint recipe run --dir=explainer-run
pnpm glint recipe status --dir=explainer-run
pnpm glint recipe resume --dir=explainer-run
```

在其他 Agent 中用本 Skill 的 `scripts/glint.mjs` 启动器替代 `pnpm glint`，其余参数相同。不要凭聊天中的“批准”跳过实际 `approve`：确认绑定资料、工程、步骤和报价摘要。

编辑生成目录中的 `source.md` 或 `project.json` 后，先执行 `recipe plan --dir=explainer-run` 重建计划，再检查和批准新摘要。重规划保留原视觉与声音选择；显式 `--visual` / `--voice` 才改变对应选项。已开始执行的目录不能重规划，改稿需用新目录，旧产物保留。

## 执行边界

- `--visual=aigc` 可生成声明式计划，但本阶段尚未接入可靠付费执行，批准和执行会被拒绝；不会改成 MG。
- 本地“模型服务费 0”不包含电费、硬件成本或人工成本。未知费用禁止新的付费调用，不猜价格。
- `--voice=existing` 当前只接受无外部音频的工程，因此输出无旁白。`--voice=sapi` 是显式本地声音选项，需 Windows SAPI 可用；未实测的机器不保证支持。
- 恢复核对原 journal 和产物摘要；已完成步骤不重复渲染。旧步骤处于 running/failed 等不确定状态时停止，不能靠 resume 重放未知副作用。
- 首版固定本地原生场景，不接受外部音频、URL、任意工具或原始 shell 参数。扩展配方应登记受审适配器，不能直接放开输入包执行。

输出包含工程、视频、原构建回执、QA 与任务 journal。QA 的 yellow 提示仍需处理或说明，不等于审美验收。
