# 创作与模板

## 生成

```bash
pnpm glint templates
pnpm glint make --source=source.md --template=explainer --theme=cream-editorial --aspect=9:16 --fps=24 --max-scenes=6 --tts=sapi --music=off
```

`make` 保存来源、项目和逐句质量报告，再调用 renderer。`--engine=heuristic` 是默认的资料模式，不请求模型。`--idea="主题" --engine=llm` 先扩写文档，再生成场景；扩写内容不是独立证据。

模型配置仅在服务端环境提供：`GLINT_LLM_API_KEY`，可选 `GLINT_LLM_BASE_URL`、`GLINT_LLM_MODEL`。当前 Agent 直接生成 SceneScript 的路径见仓库 Skill，不需要这些变量。

`max-scenes` 包含标题，范围 1..100；fps 范围 24..60。指定比例、主题、帧率及场景上限会在模型返回后落实；模板合同不满足时失败，不静默切换模板。截断场景可能使叙事不完整，导出前需审阅。

## 12 个模板

| 模板 | 资料要求 | 输出策略 |
|---|---|---|
| explainer | 正文、列表或代码 | 概念、要点、引语、代码 |
| listicle | 至少一个要点 | 按小节编号 |
| versus | 两个有内容的小节 | 并排对比与补充要点 |
| paper | 明确的方法、结果小节 | 原文研究结构与流程 |
| howto | 两个步骤或小节 | 步骤图与操作说明 |
| timeline | 两个日期/阶段小节 | 保留原文事件顺序 |
| faq | 问题小节 | 问题与解释 |
| mythfact | 误区、事实小节 | 误区对照 |
| case-study | 至少两个背景/行动/结果小节 | 案例路径 |
| problem-solution | 问题、方案小节 | 问题和方案对照 |
| code-walkthrough | 代码块 | 代码片段 |
| recap | 正文或列表 | 跨小节摘要 |

主题：`glint-dark`、`glint-light`、`cream-editorial`、`mint-clean`、`bold-poster`。CLI 和 Web 共用浏览器安全的模板目录。

## 逐句审阅

```bash
pnpm glint check --project=project.json --source=source.md --out=out/review.json
```

报告针对旁白，列出词汇候选的原文偏移、分数，以及未匹配、数字变更、否定差异、重复提示。API `reviewProject(project, source, {terms:[["术语", "别名"]]})` 另支持显式术语组检查。匹配分数不是事实正确率。`--strict` 在存在提示时返回非零退出码，适合要求人工复核的流水线。

## 代码与媒体

`--code=../repo` 只做静态扫描：最多 400 个目录项、12 个小型源文件，输出真实路径、声明候选的行号、字面导入和原文片段，不执行项目。该扫描不是语义调用图；TypeChecker 调用图与显式启动/界面采集另见[代码走读](code-walkthrough.md)。

SceneScript 支持 title、bullets、definition、quote、comparison、code、image、diagram、three、html。3D 支持本地 glTF/GLB；素材 staging 会检查路径和大小。HTML 的 GSAP 模式使用绝对帧 seek，静态模式禁用脚本。来源字段不表示已加载该来源。

长内容会缩放以适应预留区域；窄比例对比、流程采用纵向排列。代码按画面容量分页，字幕按词时间分页。过长的内容应拆场景，自动缩小不保证阅读舒适度。

## 配音与试讲

语音：`--tts=auto|edge|sapi|mock|qwen`；mock 是静音。自动路径尝试 Edge，Windows 可回退 SAPI。Qwen 需要独立 Python 环境、本地模型和参考音频，见[本地语音克隆](voice-cloning.md)。真实远程服务需单独验收。

默认并发 2，可用 `--tts-concurrency=1..8` 调整；缓存位于 Studio 的 `.cache/tts/`，包含旁白和音频，只在本地。`--no-cache` 禁用缓存。文字、声音、语速和 provider 命名空间均参与缓存键；不要将含私人旁白的缓存分享出去。

`--rehearse` 生成虚拟听众反馈；`--polish` 最多局部重讲两个场景。这些步骤需要用户配置的模型。虚拟反馈不代表真实观众反馈。

自定义画像用 `--persona-pack=pack.json`：

```json
{"version":1,"personas":[{"id":"new-reader","name":"新读者","prompt":"指出未解释的术语和跳过的推理。"}]}
```

画像包为本地 JSON，最多 10 个画像，不执行脚本。Web 下载与 HTTPS 目录安装见[画像目录](personas.md)。
