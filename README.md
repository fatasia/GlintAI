# Glint

Glint 给讲解创作者用：把资料编排成可编辑分镜，在同一套组件里预览和导出视频。

- 12 种叙事模板、5 个主题，横屏、竖屏与方屏。
- 分镜编辑、按需预览、撤销/重做、本机自动保存与项目 JSON 导入导出。
- 逐句资料候选、数字/否定提示，24 条中英回归集与受控模型修复。
- 无声草稿、系统配音、Edge 或可选 Qwen 克隆；A/B 本地听评。
- 受控并发渲染、会话素材隔离、批量复用与导出耗时报告。

## 开始

需要 Node.js 20+、pnpm 11；渲染由 Remotion 使用 Chrome，媒体检查另需 FFmpeg。

```bash
pnpm install --frozen-lockfile
pnpm web:serve
```

打开 [本机工作台](http://localhost:4175)，载入示例或粘贴资料，编排分镜后编辑、配音、导出。默认生成半尺寸**无声草稿**；一句话生成、模型编排和问答需要服务端模型配置。

也可以从命令行生成：

```bash
pnpm glint make --source=examples/entropy-lecture/source.md --tts=mock --music=off --fast
```

Windows 离线配音把 `--tts=mock` 换成 `--tts=sapi`。输出位于 `apps/studio/out/`；相对输入/输出路径按调用目录解析。

## 文档

[创作与模板](docs/authoring.md) · [数据源适配器](docs/adapters.md) · [Web/PWA](docs/web.md) · [性能基线](docs/performance.md) · [质量评测](docs/quality-evaluation.md) · [本地语音克隆](docs/voice-cloning.md) · [验证与发行](docs/release.md) · [渲染回归](docs/render-verification.md) · [Agent Skill](skills/glint-video/SKILL.md)

## 检查

```bash
pnpm test
pnpm typecheck
pnpm --filter glint-web build
pnpm verify:web
pnpm verify:render
```

本项目按 [Apache-2.0](LICENSE) 发布。依赖和素材使用各自许可证，见 [第三方组件](docs/third-party.md)。发布直连已移除；模型账号与跨设备验收状态见 [发行检查](docs/release.md)。
