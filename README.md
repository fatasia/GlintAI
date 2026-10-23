# Glint

<p align="center"><b>本地优先的视频创作工作台：资料进，成片出，全程可编辑。</b></p>

Glint 把一段资料、一句话或一个想法变成可编辑的视频工程：先编排分镜，再逐镜修改，最后渲染导出。预览与导出走同一套渲染组件，所见即所得；从生成到剪辑、配音、交付检查，全部在本机完成，模型密钥只保存在你自己的机器上。

- **一个输入框出片**：粘贴 Markdown、给一句话、或指定一个代码库，自动编排为讲解视频。离线编排不需要任何模型账号。
- **生成后仍可编辑**：12 种叙事模板 × 5 个视觉主题 × 3 种画幅；文字、图表、画面、声音逐镜修改，支持自然语言局部改稿、共享撤销与本机草稿。
- **多轨剪辑台**：视频/图片/文字/音频四类轨道（可增删至 8 条），拖动、修剪、切分、吸附、多选、撤销，淡入淡出/滑入/缩放/擦除转场，真实音频波形，快捷键齐备。预览与成片同一条管线。
- **时间线交换**：剪辑表导出 FCPXML 与 CMX3600 EDL，供 Final Cut Pro、Premiere Pro、DaVinci Resolve 二次剪辑；剪映专业版草稿导出（实验）。
- **图片 / 视频 / GIF**：接入媒体网关后可直接生成图片与短视频、导出 GIF；素材统一进素材库，工程引用本地文件。
- **声音完整**：Edge / Windows 系统音色 / 本地 Qwen 克隆 / 云端 TTS；每镜音效、配乐混音、试听波形、SRT 字幕。
- **质量门禁**：旁白依据核对、剧本质量检查、丰富度 / 静帧 / 首帧门禁、交付回执与成片技术检查。
- **桌面完整包**：自包含本地包（内置 Node、服务、CLI、UI），解压即用，无需安装仓库。

## 快速开始

需要 **Node.js 22+、pnpm 11**。渲染需要 FFmpeg 与 Chromium（Chrome 或 Edge）；Python 模型为可选项，不随安装下载。

```bash
git clone https://github.com/fatasia/GlintAI.git
cd GlintAI
pnpm install --frozen-lockfile
pnpm web:serve
```

打开 <http://localhost:4175>，载入示例，编排分镜后生成草稿。默认离线编排、无声、半尺寸，不需要任何账号。

「模型连接」可填服务地址与密钥、拉取模型列表、自动选择兼容协议并测试连接。配置只保存在服务器进程与本机数据目录；完整说明见[模型与媒体服务](docs/providers.md)。

## 命令行

```bash
pnpm glint make --source=doc.md              # 一次出片：编排 + 配音 + 配乐
pnpm glint make --idea="一句话" --engine=llm  # 模型编剧（需配置文本模型）
pnpm glint render --project=p.json           # 渲染工程为 MP4 / PNG / GIF
pnpm glint nle-render --project=nle.json --assets=<dir> --out=out.mp4   # 多轨成片
pnpm glint nle --project=p.json --video=out.mp4 --format=fcpxml|edl     # 时间线交换
pnpm glint jianying --project=p.json --video=out.mp4                    # 剪映草稿导出（实验）
pnpm glint check --project=p.json --source=source.md                    # 旁白依据核对
```

输出默认在 `apps/studio/out/`，相对路径按调用目录解析。

## 剪辑台（多轨 NLE）

首页右上「剪辑台」进入。四类轨道（视频 / 叠加 / 文字 / 音频），支持增删至 8 条、静音与锁定；片段支持拖动、双缘修剪、播放头切分、复制、速度 0.25–4×、不透明度、位置 / 缩放 / 旋转、色彩效果；转场在片段时长内完成，预览与导出逐帧一致。音频片段绘制真实波形；空白处拖框可框选片段。快捷键：`Space` 播放、`Delete` 删除、`S` 切分、`←`/`→` 单帧、`Shift+←/→` 1 秒、`Ctrl+Z` / `Ctrl+Shift+Z` 撤销重做。导出 MP4、NLE JSON，或直接产出 FCPXML / EDL（文字片段无法写入剪辑表时会明确提示）。

预览（Remotion Player）与成片渲染共用同一个 composition：预览里看到的每一帧就是导出得到的每一帧。

## 架构

```
packages/
  scenescript/   工程合同：分镜工程（SceneScript）与多轨剪辑（NleProject），zod 校验 + 纯函数编辑操作
  composer/      编排器：模板、启发式/模型编排、创作包、剧本质量检查、LLM 规划
  video/         Remotion 组件：预览与渲染共用（分镜 + NLE composition）
  design-tokens/ 风格包：字体 / 构图 / 动效 / 节奏 / 声音元数据
  knowledge/     检索与问答：分词、知识库、有据回答
  tts/ music/ media/  配音 / 配乐 / 媒体网关客户端
apps/
  web/           本地服务（HTTP API、任务队列、媒体库）+ 工作台 UI
  studio/        CLI（glint 命令）与渲染器（Remotion 渲染、native SVG、QA 门禁）
  desktop/       Windows 桌面宿主与便携包打包脚本
skills/glint-video/   Agent 技能：一条命令出片，与软件共享同一工程
```

`SceneScript` 描述"拍的片子"（分镜、旁白、效果、主题），`NleProject` 描述"剪的片子"（轨道、片段、修剪）。两个合同独立演进，渲染端共用 Remotion。

## 从源码

```bash
pnpm typecheck
pnpm test                # 全量单测；真实浏览器/付费网关测试需显式环境变量，默认跳过
pnpm --filter glint-web build
pnpm verify:budget       # 首屏 gzip 预算（160 KiB）
pnpm desktop:package:check   # 便携包冒烟：服务 → 真实渲染 → UI
```

需要系统安装 FFmpeg；浏览器流程测试需要 Chrome/Edge（可用 `GLINT_CHROME_PATH` 指定）。

## 文档

[创作与模板](docs/authoring.md) · [工作台](docs/web.md) · [模型与媒体服务](docs/providers.md) · [动画](docs/motion.md) · [剪辑台](docs/nle-editor.md) · [时间线交换](docs/nle-export.md) · [本地语音克隆](docs/voice-cloning.md) · [Docker 部署](docs/deployment.md) · [性能](docs/performance.md) · [质量评测](docs/quality-evaluation.md) · [验证命令](docs/release.md)

## 状态与边界

本项目处于 **0.1.x**：适合本机创作与单用户部署。不含团队权限、计费、云服务；生成类能力依赖你自己配置的模型服务。已知限制：NLE 暂不支持关键帧与曲线变速；FCPXML/EDL 在结构层验证、未在全部剪辑软件真机回归。

欢迎通过 [Issue](https://github.com/fatasia/GlintAI/issues) 反馈或提交 PR，参见[贡献指南](CONTRIBUTING.md)与[安全说明](SECURITY.md)。

## License

[MIT](LICENSE)
