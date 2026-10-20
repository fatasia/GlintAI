# Glint

[![CI](https://github.com/fatasia/GlintAI/actions/workflows/ci.yml/badge.svg)](https://github.com/fatasia/GlintAI/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

Glint 是面向讲解创作者的开源视频工作台：把资料变成可编辑分镜，预览、配音并导出 MP4。

- **资料到分镜**：12 种叙事模板、5 个主题，支持中文、英文和三种画面比例。
- **随时修改**：文字、图表、旁白和自然语言局部编辑，撤销重做、本机草稿与项目 JSON。
- **声音与素材**：本地 Qwen、Edge、云端 TTS，以及媒体网关的图片、短视频和 Suno / MiniMax 音乐。
- **可编程动画**：Remotion 共用预览与渲染组件，支持帧驱动图表、HTML / GSAP、Lottie 和 Three.js。
- **可检查的输出**：旁白依据提示、模板回归、音频自动检查、受控并发和导出耗时记录。

## 快速开始

需要 **Node.js 22+、pnpm 11**。视频渲染需要 Chromium 与 FFmpeg；Python 模型是可选项，不随安装下载。

```bash
git clone https://github.com/fatasia/GlintAI.git
cd GlintAI
pnpm install --frozen-lockfile
pnpm web:serve
```

打开 [本机工作台](http://localhost:4175)，载入示例，编排分镜后生成草稿。默认离线编排、无声、半尺寸，不需要模型账号。

「模型连接」可输入服务地址与密钥、获取模型列表、自动选择兼容协议并测试连接。配置只留在服务器进程中；重启后通过环境变量恢复。完整配置见 [模型与媒体服务](docs/providers.md)。

命令行同样可用：

```bash
pnpm glint make --source=examples/entropy-lecture/source.md --tts=mock --music=off --fast
pnpm glint render --project=examples/charts/project.scenescript.json --music=off --encoding=balanced
```

输出默认位于 `apps/studio/out/`。相对路径按调用目录解析。

## 文档

[创作与模板](docs/authoring.md) · [工作台](docs/web.md) · [模型与媒体](docs/providers.md) · [动画](docs/motion.md) · [本地语音克隆](docs/voice-cloning.md)

[Docker 部署](docs/deployment.md) · [性能](docs/performance.md) · [质量评测](docs/quality-evaluation.md) · [验证命令](docs/release.md) · [数据源](docs/adapters.md)

## 开发

```bash
pnpm typecheck
pnpm test
pnpm verify:release
```

本项目处于 **0.1.x**：适合本机创作和带访问控制的单用户部署，不含团队权限、计费或平台发布直连。服务协议支持情况与真实验收范围见 [验证文档](docs/release.md)。

欢迎通过 [Issue](https://github.com/fatasia/GlintAI/issues) 报告问题或提交 PR。参见 [贡献指南](CONTRIBUTING.md)、[安全说明](SECURITY.md) 和 [第三方许可](docs/third-party.md)。源码使用 [Apache-2.0](LICENSE)。
