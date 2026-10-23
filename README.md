# Glint

<p align="center"><b>一个帧函数。一条时间线。一套渲染器。</b><br><sub>One frame function. One timeline. One renderer.</sub></p>

<p align="center">看到的每一帧，就是导出的每一帧。</p>

---

Glint 是一套本地优先的视频创作工作台：资料、想法或素材进来，可编辑的工程出去。分镜可以逐镜修改，时间线可以逐帧剪辑，导出前就能看到最终画面——因为预览和成片由同一份代码绘制。

**帧是唯一的真相。** 剪辑台的画面由一个 `renderFrame(project, t)` 绘制：编辑器用它播放，渲染器用它逐帧截图，ffmpeg 只负责编码。没有第二套预览实现，也就不存在"预览和成片不一致"。

**工程是合同，不是脚本。** `SceneScript` 描述镜头与旁白，`NleProject` 描述轨道与片段，两者都由 zod 校验、纯函数编辑、可 JSON 往返。生成的片子可以继续改，改完的片子可以继续生成。

**本机优先。** 渲染、剪辑、配音、质量检查都在你的机器上完成；模型密钥只存在本机，素材不出本地。生成类能力接你自己的服务，离线编排不需要任何账号。

**交付可验证。** 旁白依据、剧本质量、丰富度与首帧门禁、交付回执、成片技术检查——每条结论都有对应的检查项，不靠感觉。

## 能力

- **分镜创作**：12 种叙事模板 × 5 个视觉主题 × 3 种画幅；Markdown、一句话或代码库入口。
- **多轨剪辑**：视频 / 叠加 / 文字 / 音频四类轨道，可增删至 8 条；拖动、双缘修剪、切分、吸附、框选、多选、80 步撤销；淡入淡出 / 滑入 / 缩放 / 擦除转场；关键帧、混合模式、几何蒙版；真实音频波形。
- **时间线交换**：FCPXML 1.9 与 CMX3600 EDL，片段级事件、轨道分层、音频 lane，导出即用，不需要重新渲染。
- **声音**：Edge / Windows / 本地 Qwen 克隆 / 云端 TTS，逐镜音效，配乐混音，SRT。
- **素材**：媒体网关生成图片、短视频与音乐，统一进素材库；GIF 导出。
- **桌面包**：自包含本地包（内置 Node、服务、CLI、UI），解压即用。

## 快速开始

需要 Node.js 22+、pnpm 11、FFmpeg，以及 Chrome 或 Edge。

```bash
git clone https://github.com/fatasia/GlintAI.git
cd GlintAI
pnpm install --frozen-lockfile
pnpm web:serve          # http://localhost:4175
```

默认离线编排、无声、半尺寸草稿，不需要任何账号。接模型在「模型连接」里填地址与密钥，配置留在本机。

## 命令行

```bash
pnpm glint make --source=doc.md                 # 资料 → 成片
pnpm glint render --project=p.json              # 工程 → MP4 / PNG / GIF
pnpm glint nle-render --project=nle.json --assets=<dir> --out=out.mp4
pnpm glint nle --project=p.json --video=out.mp4 --format=fcpxml|edl
pnpm glint check --project=p.json --source=source.md
```

## 架构

```
packages/scenescript   合同：SceneScript（镜头）+ NleProject（轨道），zod + 纯函数编辑
packages/video         帧接口：Remotion 场景组件 + 自研 NLE DOM 合成器（nle-dom）
packages/composer      编排：模板、启发式/模型、创作包、剧本质量、规划
packages/design-tokens 10 个风格包的字体 / 构图 / 动效 / 节奏 / 声音元数据
packages/knowledge     检索与有据回答；tts / music / media 为能力适配层
apps/web               本地服务（HTTP、任务队列、素材库）+ 工作台
apps/studio            CLI、渲染器、QA 门禁
apps/desktop           Windows 宿主与便携包
skills/glint-video     Agent 技能，与软件共享同一工程
```

剪辑台的渲染链：`nle-dom.renderNleFrame` 在编辑器里由 rAF 驱动，在渲染器里由无头 Chrome 逐帧 seek 后截图，帧序列交给 ffmpeg 与混音合成。一个实现，两种宿主。

详见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 文档

[创作](docs/authoring.md) · [工作台](docs/web.md) · [剪辑台](docs/nle-editor.md) · [时间线交换](docs/nle-export.md) · [模型与媒体](docs/providers.md) · [动画](docs/motion.md) · [部署](docs/deployment.md) · [验证](docs/release.md)

## 状态

0.1.x：本机创作与单用户部署。不含团队权限、计费与云端服务。已知边界见 [剪辑台限制](docs/nle-editor.md) 与 [发行说明](docs/release.md)。

欢迎 [Issue](https://github.com/fatasia/GlintAI/issues) 与 PR，见 [贡献指南](CONTRIBUTING.md)、[安全说明](SECURITY.md)。

[MIT](LICENSE)
