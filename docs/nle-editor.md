# 剪辑台（多轨 NLE）

桌面多轨剪辑。预览与成片共用同一条 Remotion 管线（preview = export）。

## 功能

- **轨道**：视频 / 叠加 / 文字 / 音频四类，可在时间线底部增删，上限 8 条；每条可静音、锁定，锁定后拒绝编辑并给出提示。
- **片段操作**：拖动移动、双缘修剪、播放头切分、复制、删除；速度 0.25–4×（源入点自动跟随）、不透明度、位置 / 缩放 / 旋转、7 种色彩效果（复用 SceneEffect 原语）。
- **多选与框选**：Shift+点击增减选，整组拖动 / 删除；在时间线空白处拖框，选中矩形触及的所有片段。
- **吸附**：默认开启。吸附到其他片段两端、播放头与 0 点，阈值 8 px，命中时显示黄色参考线。
- **撤销 / 重做**：`Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+Y`，最多 80 步。属性输入框以一次聚焦为一个事务（不逐字符占历史）；拖拽以一次按下→抬起为一个事务；轨道删除同样可撤销。
- **快捷键**：`Space` 播放/暂停，`Delete` / `Backspace` 删除，`S` 在播放头切分，`←`/`→` 单帧（`Shift` 为 1 秒），`Home` / `End` 首尾。
- **音频波形**：按素材真实解码绘制 80 段峰值（SVG），同一素材只解码一次并缓存。
- **转场**：每个视觉片段可设入场 / 出场转场：淡入淡出、滑入、缩放、擦除，时长 100–5000 ms。转场在片段自身时长内完成，不需要相邻片段重叠，因此预览与导出逐帧一致。
- **文字片段**：内容、字号、颜色、字重、对齐；Canvas 绘制，预览与导出字形一致。
- **关键帧**：在播放头记录位置 / 缩放 / 旋转 / 不透明度，2–32 个、严格递增，段间线性或缓动插值；逐字段独立插值，未记录的字段保持静态值。
- **混合与蒙版**：7 种混合模式（normal/screen/multiply/overlay/darken/lighten/soft-light）；圆形或矩形蒙版，支持羽化、内缩与反转。
- **素材库**：直接使用媒体工坊生成的图片 / 视频 / 音频；一键加入匹配类型的轨道，没有可用轨道时自动新建。

## 导出

- **MP4**：balanced 编码，含音频混音。
- **FCPXML / EDL**：直接把时间线写成剪辑决策表（每片段一个事件、按轨道分层、音频 lane），不需要重新渲染；文字片段无法写入 CMX3600/FCPXML，会在界面明确提示数量。见 [nle-export.md](nle-export.md)。
- **NLE JSON**：完整工程导入 / 导出，本机自动保存；旧版工程键自动迁移。

## 合同（`packages/scenescript/src/nle.ts`）

`NleProject`：schemaVersion、id/title、fps、width/height、background、tracks（≤8）。
`NleTrack`：kind（video/overlay/text/audio）、name、muted、locked、clips（≤200）。
`NleClip`：video/image/audio/text 四类；公共字段 startMs、durationMs、trimStartMs、speed、opacity、transform、transitionIn/Out、effects；音视频带 volume。
`NleTransition`：type（fade/slide/zoom/wipe）+ durationMs（100–5000，默认 500）。
校验：片段类型必须匹配轨道类型、id 全局唯一、时间非负。

纯函数操作（全部有单测）：`nleMoveClip` / `nleTrimClip` / `nleSplitClip` / `nleRemoveClip` / `nleAddTrack` / `nleRemoveTrack` / `nleDurationMs` / `nleClipSourceEndMs` / `nleTransitionProgress` / `nleSampleMotion` / `nleSnapPoints` / `nleSnap`。编辑器与渲染器共用同一份实现。

## 渲染

剪辑台不经过 Remotion：`renderNleFrame(host, project, tMs)` 在编辑器里由 rAF 驱动，在渲染器里由无头 Chrome 逐帧 seek 后截图，帧序列与混音交给 ffmpeg。一个实现、两种宿主，因此预览与成片不会漂移。文字用 Canvas 2D 绘制以消除合成层光栅化差异。

## 已知限制

- 速度为整段匀速，无曲线变速。
- 转场为片段内边缘转场，无跨片段重叠式溶解。
- 蒙版为几何形状 + 羽化，无手绘遮罩与跟踪。
- FCPXML/EDL 在结构层验证，未覆盖全部剪辑软件版本。
- 渲染依赖系统 Chrome/Edge；无头截帧逐帧进行，长片导出时间随帧数线性增长。

## 用法

首页右上「剪辑台」进入；或 CLI：

```bash
pnpm glint nle-render --project=nle.json --assets=<素材目录> --out=out.mp4
```
