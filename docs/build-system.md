# 可复现构建（plan / build / verify / diff / prove / apply / mcp）

这一层回答三个问题：**这次改动要重算什么、花了多少、别的地方有没有被弄坏。**
它不改变现有渲染命令；`glint build` 只是给 `render-native` 包了一层预算、回执和校验。

## 快速开始

```bash
# 1. 预测（不渲染）
pnpm glint plan --project=examples/independent-deck/project.scenescript.json --budget

# 2. 渲染并写回执；--assert-budget 在“实际重算 ≠ 预测”时失败
pnpm glint build --project=examples/independent-deck/project.scenescript.json \
  --out=../outputs/demo.mp4 --tts=mock --music=off --fast --assert-budget

# 3. 校验产物、环境与可重建性（L0 要求字节一致）
pnpm glint verify --receipt=../outputs/demo.mp4.receipt.json --rebuild

# 4. 只改一个字段：先预测，再渲染
pnpm glint plan --project=… --set='scenes[0].title="新标题"'
pnpm glint build --project=… --out=../outputs/demo2.mp4 --set='scenes[0].title="新标题"' --assert-budget

# 5. 证明“只改了该改的”：帧级差异
pnpm glint diff --before=../outputs/demo.mp4 --after=../outputs/demo2.mp4 --fps=2

# 6. 机器断言
pnpm glint prove --project=… --tests=glint.tests.json --receipt=../outputs/demo2.mp4.receipt.json
```

## 输出物

| 文件 | 内容 | 是否应提交 |
|---|---|---|
| `<out>.mp4` | 成片 | 按需 |
| `<out>.mp4.receipt.json` | 回执：节点摘要、环境指纹、预测/实际、L1–L3 校验、产物 sha256、recipe | **建议**作为交付的一部分 |
| `.glint/manifest.json` | 上次构建的节点摘要与渲染参数，供下次预测 | 否（本机状态，已 gitignore） |

## 回执字段

| 字段 | 含义 |
|---|---|
| `project.revision` | 工程内容的 sha256 前缀 `sha256:`，用于 CAS |
| `project.changes` | 本次叠加的 `path=value` 编辑；`verify --rebuild` 会照此复现 |
| `recipe` | `fast/plate/resolution/tts/music`，重建必须一致 |
| `reproducibility` | `L0`（无浏览器场景，要求字节一致）/ `L1`（含 Chrome 场景，允许帧差容差）/ `L2`（含外部快照）——**L2 为计划中，Snapshot 尚未实现** |
| `plan.predicted` / `plan.actual` | L1 定律：预测集合必须等于实际执行集合 |
| `nodes[].digest` | 构建图节点摘要（输入 + 参数 + 环境） |
| `output.sha256` | 成片哈希 |
| `verification` | L1 预算、L2 产物、L3 场景级来源；`verify` 还会用 ffprobe 核对解码帧数是否等于 provenance 覆盖的帧数 |

## 断言格式（`glint.tests.json`）

```json
{
  "assert": [
    { "scenes": { "count": 2 } },
    { "only": ["control"] },
    { "change": { "maxCostCny": 0, "maxModelCalls": 0 } },
    { "output": { "minBytes": 1000 } },
    { "determinism": { "level": "L0" } }
  ]
}
```

只支持能被机器判定的谓词：`only / change / determinism / output / scenes`。
需要 OCR、审美或人工判断的断言会**报错**，不会静默通过。

## 预算为什么可能“不精确”

- 场景缓存是**内容寻址**的：一个改动的场景如果历史上已经渲过，成本就是 0；`plan` 会如实显示 `changed` 与 `predicted` 的差别。
- 没有显式 `narration.durationMs` 的工程，TTS 会决定时长，预算只能是近似值；此时 `--assert-budget` 会拒绝，而不是给假绿灯。
- 音频混音按内容寻址缓存（`audioMixKey` → `.cache/native-audio`），但预算仍把 `audio:mix` 标为不透明节点：TTS 产出的真实时长只能在合成后确定，预测阶段无法精确判定命中。

## MCP

```bash
pnpm glint mcp   # newline-delimited JSON-RPC over stdio
```

工具：`glint_plan`、`glint_apply`、`glint_build`、`glint_prove`、`glint_verify`。
stdout 只走协议；构建日志走 stderr。

## 目前不承诺的

- L3 来源目前是**场景级帧区间**（rendered / footage），不区分模型/种子；生成素材接入 snapshot 后才会出现 `generated` 与 model/seed 字段。
- ffprobe 不可用时，`verify` 不做解码帧数核对，也不会伪报这一项通过。
- 跨机器字节一致：`verify` 会报告环境漂移并归因（字体/浏览器/resvg/Node），但不宣称自动修复。
- 图层级缓存：当前粒度是场景，节点粒度会随合成器演进升级。

## 时间与帧率

- `fps` 支持 24/25/30/50/60，也支持写成 `23.976` / `29.97` / `59.94`；内部按 `24000/1001`、`30000/1001`、`60000/1001` 精确换算，ffmpeg 收到的是有理数文本（`-framerate 30000/1001`）。
- 帧号换算统一走 `framesForMs`/`msForFrame`（`packages/scenescript/src/frame-rate.ts`），不再用 `ms/1000*fps` 四舍五入；1001ms 在 29.97 下稳定等于 30 帧。
- `video` 场景新增 `speed`（0.25–4）。合成帧 → 源时间用 `sourceTimeForFrame(frame, fps, {speed, trimStartSec})`，Chrome 直驱层按该值 seek。

## 资产身份（C13）

```json
{
  "assets": [
    { "id": "hero", "kind": "character", "name": "主角", "version": "v1", "refs": ["assets/hero.png"] }
  ],
  "scenes": [
    { "id": "one", "kind": "title", "title": "One",
      "narration": { "text": "a", "durationMs": 500 },
      "assetRefs": [{ "assetId": "hero", "version": "v1" }] }
  ]
}
```

- 版本是显式 pin：`assetRefs.version` 必须等于 `assets[].version`，否则解析失败；未知资产、重复引用也会失败。
- 场景缓存 key 只包含**该场景引用**的资产身份，因此改角色版本只失效相关镜头，不误伤其它镜。
- `pnpm glint assets --project=p.json` 列出身份、引用它的镜头、缺失的 refs 文件与未被引用的身份。
## 对象与关键帧（C11/C12）

场景可以在内容之上叠一层可编辑对象：

```json
{
  "elements": [
    { "id": "price", "kind": "text", "text": "¥199", "x": 0.5, "y": 0.72, "fontSize": 64 },
    { "id": "card", "kind": "rect", "x": 0.2, "y": 0.2, "w": 0.3, "h": 0.2, "fill": "#112233", "radius": 8 }
  ],
  "tracks": [
    { "elementId": "price", "property": "x", "keyframes": [
      { "atMs": 0, "value": 0.5 }, { "atMs": 800, "value": 0.78, "easing": "ease-out" }
    ]},
    { "elementId": "price", "property": "opacity", "keyframes": [
      { "atMs": 0, "value": 0 }, { "atMs": 400, "value": 1 }
    ]}
  ]
}
```

- 属性：`x` / `y`（0..1 画布坐标）、`opacity`（0..1）、`scale`、`rotate`（度）。
- 缓动：`linear` / `ease-in` / `ease-out` / `ease-in-out`，或 `{ "bezier": [x1, y1, x2, y2] }`；缓动写在**区间右端点**上。
- 求值只有一份：`packages/scenescript/src/elements.ts` 的 `evaluateElements`，SVG 渲染器与 Remotion 覆盖层共用，同一毫秒必须得到同一值。
- 对象层不进 clean plate（`--plate`）：底片只保留场景内容，方便外部编辑器自行叠加。
- 改一个关键帧只失效该场景：动画是场景身份的一部分，构建预算会如实显示。