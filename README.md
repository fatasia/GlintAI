# Glint

Glint 是给内容创作者使用的本地优先工作台：在同一工程中写脚本、编辑页面和幻灯片，再剪辑和导出视频。

- **项目画布**：页面、脚本和镜头共用工程；多选排列、视口恢复，双击进入对应编辑器。
- **设计创作**：资料生成整稿、参考图设计、文字直编与对象编组；保留源码、批注和修改历史。
- **视频制作**：多轨剪辑、关键帧、蒙版和音频波形；静态幻灯片按页加入视频，配旁白、字幕与音乐。
- **本机恢复**：固定客户端地址、旧版本数据导入和可撤销的 Git 恢复；桌面版支持含素材的完整工程 ZIP。
- **交付**：MP4、GIF、静帧、HTML、PDF、可编辑 PPTX，以及 FCPXML/EDL。支持 Windows 客户端和自托管 Web。

## 快速开始

需要 Node.js 22+、pnpm 11、FFmpeg 和 Chrome/Edge；本机 Git 历史另需 Git。

```bash
git clone https://github.com/fatasia/GlintAI.git
cd GlintAI
pnpm install --frozen-lockfile
pnpm web:serve          # http://localhost:4175
```

首页选择「资料」，粘贴内容后开始创作。编辑完成后点击「导出视频 → 导出 MP4」；默认无声，可改选已配置的配音。外部模型在「连接模型」中配置，调用时提示词和所需素材会发给对应服务。

Windows 完整便携版包含 Node、服务、CLI 和界面，仍需系统 FFmpeg 与 Chrome/Edge；精简版另需 Node.js 22+。旧版本升级时客户端会引导导入旧数据，导入前自动备份、可撤销。

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

[创作](docs/authoring.md) · [工作台](docs/web.md) · [剪辑台](docs/nle-editor.md) · [时间线交换](docs/nle-export.md) · [模型与媒体](docs/providers.md) · [动画](docs/motion.md) · [部署](docs/deployment.md) · [运行模式](docs/modes.md) · [环境与版本](docs/environment.md) · [数据生命周期](docs/data-lifecycle.md) · [验证](docs/release.md)

## 状态

0.1.x：本机创作与单用户部署。不含团队权限、计费与云端渲染服务。完整功能目标尚未全部验收；[剪辑台限制](docs/nle-editor.md)和[发行说明](docs/release.md)记录已知边界。

欢迎 [Issue](https://github.com/fatasia/GlintAI/issues) 与 PR，见 [贡献指南](CONTRIBUTING.md)、[安全说明](SECURITY.md)。

[MIT](LICENSE)
