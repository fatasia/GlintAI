# 参考片复刻工作流（数字测量 → Keep/Replace → 骨架 → 对照）

把一段参考视频转成可执行的复刻计划。测量全部本地完成（FFmpeg，零模型调用）；「保留什么、替换什么」由作者或 agent 决策；骨架与评审表由 CLI 产出，导出后用 `glint verify-export` 做规格对照。

流程照抄 OpenMotion openmotion-recreate skill（Apache-2.0），命令换为 Glint。

## 1. 数字测量

```bash
pnpm glint analyze-reference --video=ref.mp4 --out=measurement.json
```

- 输出 `glint-reference-measurement` 报告：切镜表（startMs/endMs）、逐镜调色板（quantized hex + share）、全局调色板、宽高/fps/时长、报告 sha256。
- `--min-shot-ms`（缺省 800）合并碎镜；`--threshold` 调切镜灵敏度。
- 可选字幕探测（有字幕轨时输出 captions）。

## 2. 填 Keep/Replace 表

按测量 JSON 逐镜决策，写成 Markdown 表（或 JSON 数组）：

```markdown
| 镜头 | 保留 | 替换 | 证据帧 |
|---|---|---|---|
| 1 | 卡片入场节奏与机位 | 标题文案换成新品名 | 12 |
| 2 | 传送门展开时长 | 配色换成品牌绿 | 45 |
| 3 | 白场收尾 | 全部替换为本片素材 |  |
```

- 「证据帧」列可选：帧号从 0 计，按测量 fps 换算成毫秒写入计划。
- 规则：恰好覆盖每个镜头；重复镜头、越界、keep 空白都会被拒绝（重复优先报错）。

## 3. 生成复刻骨架

```bash
pnpm glint recreate-plan --measurement=measurement.json --table=keep-replace.md --out=recreate.project.json
```

- 骨架镜头数与时长**严格对齐测量值**（含切点）；Keep/Replace 进入逐镜占位说明。
- 用编辑器或 `glint make` 补齐替换内容后正常渲染。

## 4. 评审与对照

- 评审表逐镜给出证据帧号（未填则取该镜中点），用于渲染后抽帧对比。
- 导出成片后跑 `pnpm glint verify-export --video=out.mp4 --expect-width=<测量宽> --expect-height=<测量高> --expect-duration-ms=<测量时长>`：规格对齐 + remainingChecks 提醒人工看画面。

## 边界

- 测量只覆盖「切镜 + 调色板」（cuts-and-palette scope）；运镜、字体、节奏语义由 agent 结合参考帧自行判断。
- 字幕探测为 best-effort；测量报告带 sha256，作为后续对照的固定基准。
