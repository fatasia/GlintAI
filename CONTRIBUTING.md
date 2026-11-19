# 贡献指南

使用 Node.js 22+、pnpm 11，先运行 `pnpm install --frozen-lockfile`。

- 修复问题时附最小复现，并为行为变化加回归测试。
- 功能改动保持 SceneScript、预览与导出的合同一致。
- 使用 `pnpm typecheck`、`pnpm test`、`pnpm --filter glint-web build` 检查；渲染变化另外运行 `pnpm verify:render`。
- 不提交密钥、用户资料、模型权重、生成媒体、临时报告或本机绝对路径。
- PR 说明改了什么、为什么改、实际运行哪些检查。付费服务测试是可选的，说明未运行的服务即可。

## 测试夹具与本地工具

一部分测试依赖本机工具与渲染出的夹具，缺什么就跳过对应用例，不会失败：

- FFmpeg / ffprobe：渲染与参考分析测试需要；没有则相关用例自动跳过。
- Chrome/Edge：浏览器端到端测试需要（`GLINT_BROWSER_UI_TEST=1` 时启用；`GLINT_CHROME_PATH` 可指定路径）。
- Rust 工具链：桌面安全素材桥的测试需要先 `cargo build --manifest-path apps/desktop/secure-assets/Cargo.toml`。
- 渲染夹具（风格样片、语法样例）：`node scripts/prepare-test-fixtures.mjs --stages=styles --chrome=<chrome 路径>` 用本机 Chrome 现场渲染，不下载任何文件。
- 首次全量跑测试前建议先跑一次上面的夹具准备；CI 里对应步骤见 `.github/workflows/ci.yml`。

## 目录

`apps/web` 是工作台与单用户 HTTP 服务；`apps/studio` 是 CLI 与渲染编排。`packages` 包含 SceneScript、composer、video、LLM、TTS、media、music、knowledge 等可复用模块。`examples` 放小型可复现资料，`scripts` 放维护和验收工具。
