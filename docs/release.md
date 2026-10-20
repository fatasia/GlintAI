# 验证与发行

本页记录已实现的本机能力与仍需外部环境的验收，不把 CI 配置、模型协议或目录协议当作已上线服务。

## 2026-10-21 · 本轮交付

本轮只处理生成质量、语音工作流、编辑体验及性能；未增加公网部署、跨平台商业化或发布直连。

- 56 个测试文件、459 项单测与类型检查通过；独立目录安装、类型、单测、Web 构建通过，安装复用了本地 pnpm store。
- 新增分镜编辑、撤销/重做、自动保存、JSON 导入导出、按需播放器、预览错误边界，以及编辑项目直接导出；实际浏览器已修改旁白并生成 MP4。
- 24 条中英模板合同、3 条数字/否定/无关断言故障提示通过；模型 JSON/schema 修复次数有限制，超长资料不再静默截断。
- Web 支持无声/SAPI/Edge/已配置 Qwen，四档导出。Qwen 缓存到 MP4 链路重验通过；听评界面支持本地参考/候选播放与人工评分，不自动填写分数。
- 同素材并发 1→4，渲染编码均值 10.421→6.579 秒（约 -36.9%），六份 MP4 字节一致。预览按需加载与压缩预算见[性能报告](performance.md)。

真实模型质量与人工听评仍待用户配置/实际评分。本轮没有重新验证 macOS、Linux GPU、真实移动设备或公网服务。

浏览器功能测试覆盖资料编排、旁白编辑、撤销/重做、保存、预览及成片；音频元数据正常解码。截图接口本轮不可用，未生成新的 UI 截图；临时视口设置已恢复，没有修改用户缩放。

下文的 2026-10-20 数值是上一轮历史记录，不代表本轮跨平台测试数。

## 一次运行本机验收

```bash
pnpm verify:release
pnpm verify:release --benchmark --local-config=D:/checks/local-verification.json
pnpm verify:install --online
pnpm verify:linux
```

`verify:linux` 需要已运行的本机 Docker Linux 引擎，以只读源码挂载和匿名官方 Node 镜像执行，不传入宿主凭据；测试容器结束后删除，报告和源码副本保留。它不会自动启动 Docker。

统一命令依次执行类型、单测、Web 构建、真实 HTTP/CLI 出片、代码预览进程、批量渲染、两个尺寸的像素回归和长内容布局。`--benchmark` 增加三档编码各三次的基准。所有报告和过程图写入仓库外的临时目录；本机检查全部通过时状态为 `local-passed`，外部验收状态另列。

可选模型配置只包含本地路径：

```json
{"qwenPython":"D:/runtime/qwen/venv/Scripts/python.exe","qwenModel":"D:/runtime/qwen/model","referenceAudio":"D:/runtime/qwen/reference.wav","mediaPython":"D:/runtime/media/venv/Scripts/python.exe","whisperModel":"D:/runtime/media/whisper-tiny","mediaSuite":"D:/checks/media-suite.json"}
```

有配置才额外执行 Qwen 长文本/显存/声音 embedding 诊断及 OCR/Whisper 识别集；不自动安装模型、不寻找账号密钥、不请求付费 API。`verify:edge` 单独检查 Edge 远程配音，默认验收不依赖其网络可用性。

## 已实现并在本机验证

| 能力 | 实际范围 |
|---|---|
| 模板与审阅 | 12 模板、参数合同、逐句原文候选、数字/否定/重复提示；候选不是事实判定 |
| Web/PWA | 真实 CLI 出片、进程树取消、幂等、重启恢复、Range/下载、断网页面与更新确认 |
| 回执丢失恢复 | POST 前保存 requestId；刷新后只读查找原任务，实际浏览器模拟丢失响应后恢复并下载成片 |
| 压缩素材与动画 | 原始 glTF/GLB、真实 DRACO、ETC1S KTX2、GSAP、Lottie light Canvas、自定义 Three 工厂 |
| 同文档像素回访 | 84 帧双轮全 RGBA、22 次冷采样、86 次单文档乱序/重复帧上下文；不直接等价于 Player seek API 测试 |
| HTML 资源隔离 | 独立外层 CSP 与内层沙箱；网络、资源、父 DOM、导航探针；不改变宿主页 CSP，不是通用敌对代码执行服务 |
| 语音 | SAPI 非静音及缓存；真实 Edge 远程输出；本地 Qwen 单句、28.8 秒段落、英文、MP4、显存及 embedding 诊断 |
| OCR/转录 | 本地 RapidOCR + Whisper tiny，真实中文图与三段语音识别；音频来源到 MP4 的 CLI 已跑通 |
| 代码 | 有限文件 TypeChecker 解析调用边与未解析项；显式命令启动/HTTP 就绪/停止进程树；Glint 自身 UI 有宽屏、390px 截图 |
| 画像目录 | Web 搜索/指令预览/下载，HTTPS 目录协议及 SHA-256 确认安装；没有部署公共市场 |
| 批量渲染 | JSONL/清单 worker 串行执行，两个实际任务断言 bundle=1、browser=1；新素材可在后项使用 |

Windows + Node 24 的完整单测为 49 文件、438 项通过；类型检查、Web 构建与独立目录安装通过。另在 Linux 容器 Node 22.23.3 中完成 frozen 安装、类型、同样 438 项单测与 Web 构建，官方镜像摘要记在 Linux 报告中；没有据此宣称 Linux 浏览器/GPU 渲染已通过。Three 延迟加载块仍约 940 kB，构建会给体积提示。独立目录安装复用本机 pnpm store、禁用依赖脚本，不是全新机器验收。

布局命令生成三比例 × 七类长内容，共 21 张 PNG；已看代表性结果，不把“生成成功”当成所有素材的视觉验收。工作台实测过模板选择、提交/完成、刷新恢复、小测、画像搜索/下载和 PWA；新一轮截图接口已恢复，1441px 宽屏和 390px 窄屏检查没有横向溢出。模拟视口不等于真机。

Qwen 诊断、识别集和范围见[语音克隆](voice-cloning.md)、[适配器](adapters.md)；模型自身的 speaker embedding cosine 不是人工听评或独立身份鉴定。编码基准报告同机同素材的耗时、字节与 PSNR，不外推其他素材或主观画质。

## 仍需外部条件

| 验收项 | 缺少的条件 |
|---|---|
| 真实 API 编剧/问答/试讲质量 | 当前没有配置 GLINT_LLM_API_KEY；需用户自己的服务配置与评测资料 |
| macOS、Linux 原生浏览器/GPU、真实手机、Safari/Firefox | Linux 容器基础检查已通过；其余缺少对应系统、浏览器和设备，远程 CI 尚未运行 |
| 公共画像目录/多用户部署 | 需要明确主机、域名及访问控制方案；本地服务保持 loopback，不直接对外暴露 |
| 人工声音相似度与真实观众评测 | 需要听评/作答人员及具体评测标准；机器代理指标不代替人的判断 |

代码项目仍需操作者给出正确启动命令、依赖和测试数据，不自动猜测任意项目的启动方式。Lottie 与 Three 使用明确的帧合同，不承诺所有 AE 效果、npm 插件或非确定性脚本都能执行。

平台发布直连已按需求移除。2026-10-20 的验收未执行 commit/push。后续源码上传以 GitHub 提交记录为准；未发布 npm 包或全局安装 Skill。

## 分项入口

[渲染回归](render-verification.md) · [批量渲染](batch-render.md) · [动画合同](motion.md) · [代码走读](code-walkthrough.md) · [画像目录](personas.md) · [Web/PWA](web.md)
