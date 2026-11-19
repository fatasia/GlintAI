# 验证与发行

## 2026-10-31 本机验收版（未发布）

创作首页改为「输入 → 可编辑工程 → 导出」，不先渲染再进入编辑；工作台集中画面、镜头和持续对话，版本、参数、备份按需展开。最新试用包、测试与参考来源见[流程改版记录](handoff/GLINT-UI-FLOW-2026-10-31.md)。

补齐未保存输入的离开保护、设计扩展属性、多份本机 Git 主快照发现与隐藏设计预览暂停；修复桌面 jsdom 打包、Zod 与冻结原型冲突导致的原生空白页，以及冻结安装缺少锁记录的问题。

改版后默认全仓回归 3431 项通过、0 失败、104 跳过；另行显式浏览器回归 5 文件 7 项通过，包括可编辑工程到真实 MP4 下载。改版前数据保留在[执行记录](handoff/GLINT-EXECUTION-2026-10-31.md)。私有 Windows 完整包已运行真实脚本、无声 MP4 和原生首页检查；[试用流程](operations/CLIENT-ACCEPTANCE-2026-10-31.md)提供材料与通过标准。

桌面随机端口之间的 localStorage 草稿/附件迁移仍未完成，原始 36 项与竞品对照尚未全量验收；本版不作为正式 Release 部署。

## 本地检查

桌面便携包构建要求新的输出目录和归档路径，不会覆盖已有文件。需要指定隔离位置时，可设置 `GLINT_PORTABLE_OUTPUT`，以及 ZIP 构建使用的 `GLINT_PORTABLE_ARCHIVE`；归档路径必须在输出目录之外。轻量版需系统提供 Node.js 22+、FFmpeg 和 WebView2，部分渲染需要 Chrome 或 Edge。

```bash
pnpm typecheck
pnpm test
pnpm --filter glint-web build
pnpm verify:source
pnpm verify:budget
pnpm verify:release
```

`verify:release` 依次执行类型、单测、构建、源码检查、首屏预算、离线模板回归、真实 HTTP 出片、代码预览、批量渲染、双尺寸像素回归和长内容布局。报告与过程图写入系统临时目录，不进入源码。`--benchmark` 增加编码基准。

```bash
pnpm verify:install --online
pnpm verify:linux
pnpm verify:edge
```

独立安装检查复用 pnpm store；不是全新机器冷安装。Linux 检查需要已运行的 Docker，不启动宿主 Docker，也不传入账号凭据。Edge 检查依赖远程服务。

## 可选模型检查

真实模型评测需明确配置服务，且可能计费：

```bash
# 在 shell 中配置 GLINT_LLM_* 与 GLINT_EVAL_LIVE=1
pnpm eval:quality
pnpm --filter glint-studio exec tsx ../../scripts/evaluate-grounding.mjs
```

源文件、回复与逐案例结果保存在指定输出目录，提交前应留在仓库外。语音检查见 [本地克隆](voice-cloning.md)；媒体检查支持本地 Whisper / OCR，不自动安装权重。

## 自动验收范围

| 路径 | 已执行的检查 |
|---|---|
| GLM-5.3-Flash | 12 模板 × 中英文，24 项结构合同；3 项故障注入；同模型资料一致性诊断，对发现的 4 项重新生成后复查 |
| Qwen 0.6B Base | 5 段新推理样本的波形、缓存、Whisper-small；覆盖中文、英文、长文本和多音字；5/5 达阈值 |
| 媒体网关 | 模型列表、两个文本别名自动协议连接、图片生成、6 秒短视频、Suno 音乐、GEM TTS 与配乐图表 MP4 |
| 图表与视频 | 原生柱状/折线图、既有 Remotion / HTML / Lottie / Three 回归、实际 PNG / H.264 + AAC 输出 |
| 官方云端音色适配器 | ElevenLabs / Fish / MiniMax 的协议与异常回归；没有对应官方账号的真实调用 |

上述模型结果来自固定的小型回归资料，不是所有领域准确率。资料一致性使用同一模型诊断，不是独立事实判定。声音自然度、相似度、音乐审美以及完整成片效果尚无人类评分。网关模型别名不作为上游模型身份凭据。

## 发行形态未完成

- **未签名**：Windows 安装器/便携包没有代码签名证书，首次运行会触发 SmartScreen；安装版默认注册当前用户的卸载入口。安装器检查跳过快捷方式和注册表，避免修改用户桌面。
- **无自动更新**：没有更新服务器、签名清单或差分包；桌面宿主只提供“有新版本，重新加载”的 Web 资源提示。
- **平台**：Windows 为实测平台；macOS/Linux 宿主与捕获浏览器未实测，`verify:linux` 只覆盖容器构建。
- **跨机器 CI**：GitHub Actions 已配置 typecheck/test/build，但本轮没有在第二台机器或真实 CI runner 上跑过；不能据此宣称跨机器复现。
- **发行前仍需**：证书与签名、更新通道、安装器快捷方式/注册表自动化验收、第二平台实机、跨机器冷安装。

## 发行前

1. 冻结锁文件，运行完整检查与相关真实模型检查。
2. 检查 `git diff`，只提交源码、可复用测试、示例和文档；排除音频、模型权重、报告、环境文件和凭据。
3. 构建生产镜像，验证 Chromium、生成、下载、重启和持久化。
4. 在对应系统 / 浏览器检查交互和布局；模拟窄屏不等于手机实机。
5. 保留回滚版本，再切换反向代理。

项目没有团队账户、配额、账单、公共画像市场或平台发布直连。公网服务应使用 HTTPS 和访问令牌，见 [部署](deployment.md)。
