# 剪辑时间线导出（FCPXML / EDL，实验）

> 状态：**能生成结构正确的文件；尚未覆盖全部剪辑软件版本的真机导入验证。**

## 它做什么

把一支**已渲染的母版 MP4**按 SceneScript 的镜头切点拆成一条时间线：

- FCPXML 1.9：一个 asset 引用母版，spine 里每个镜头一个 `asset-clip`，含精确帧率有理数、画幅、入点/出点。
- CMX3600 EDL：每个镜头一条 `CUT` 事件，附 clip name 与源文件名；非丢帧时间码。
- 母版里的音频若存在（`narration.audioRef` 或 `project.music`），asset 标记 `hasAudio=1`；否则为 0。

编辑器「导出 → FCPXML / EDL」会先渲染母版 MP4，再返回时间线与母版两个下载。CLI 则需要已有母版。

## 用法

```bash
# 已有母版
pnpm glint nle --project=out/p.project.json --video=out/p.mp4 --format=fcpxml --out=out/p.fcpxml
pnpm glint nle --project=out/p.project.json --video=out/p.mp4 --format=edl   --out=out/p.edl
```

- `--format` 只接受 `fcpxml` / `edl`；其他格式直接报错。
- 输出目录自动创建；镜头数、字节数会打印。
- 23.976 / 29.97 / 59.94 的 EDL 使用非丢帧时间码，长片会漂移；优先用 FCPXML。
- FCPXML 的 `src` 是母版的**本机绝对路径**；把时间线和母版放在同一台机器上再导入。

## 已实测

| 项 | 结果 |
|---|---|
| 真实基准工程生成 FCPXML | 3 个切点，1049 bytes，1280×720，30fps，母版 15s |
| 真实基准工程生成 EDL | 3 个切点，543 bytes，时间码 00:00:00:00 → 00:00:15:00 |
| 编辑器端到端 | 2 镜测试工程 → 渲染母版 17 KB → FCPXML 下载链接与母版链接同时出现 |
| 单元测试 | `nle-export.test.ts` 4 项：切点、帧率有理数、画幅、XML 转义、EDL 事件、hasAudio |

## 真机导入指引

导出得到 `<id>.fcpxml` / `<id>.edl` 与母版 `<id>.mp4`（NLE 时间线导出还包含用到的素材文件）。请把**时间线文件与母版/素材放在同一台机器**，`src` 是本机绝对路径。

- **Final Cut Pro**：`文件 → 导入 → XML…` 选择 `.fcpxml`。检查：事件里出现工程、每个镜头一个 asset-clip、时长与切点对齐、`hasAudio` 正确。
- **DaVinci Resolve**：`文件 → 导入时间线 → AAF/EDL/XML…`。FCPXML 与 EDL 都支持。检查：媒体池链接到母版、时间线帧率与工程一致。
- **Premiere Pro**：原生支持 EDL（`文件 → 导入`），FCPXML 需要第三方转换。用 EDL 时注意非丢帧时间码的限制（见下）。

已知边界：文字片段不会出现在剪辑表里（FCPXML/EDL 无法表达，导入后在剪辑软件里重建字幕）；变速片段在 EDL 中源区间已按速度换算，但 FCPXML 未编码变速属性（时长按时间线）；转场不会导出（渲染时已烧入母版）。遇到版本兼容问题请开 Issue 并附上剪辑软件与版本号。

## 未验证 / 不做

- 未在 Final Cut Pro、Premiere、Resolve 中实际导入；不同版本对 FCPXML 1.9 的字段容忍度未测。
- 不做 AAF；不做多轨/转场/字幕轨导出（母版已烘焙画面和字幕）。
- 不把 `film.html` 当对外格式；SceneScript 仍是唯一工程合同。
- 不承诺与剪映草稿（旧实验命令）互通。
