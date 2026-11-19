# 环境与版本

Glint 是本地优先的单用户工作台。本文记录各运行环境依赖的版本基线与校验方法；升级任一依赖后应重跑渲染冒烟（`pnpm verify:web`）确认产物可解码。

## 版本基线

| 组件 | 基线 | 说明 |
|---|---|---|
| Node.js | >= 20 | `package.json` 的 `engines` 字段声明；根 `.npmrc` 开启 `engine-strict`，版本不符时安装直接失败 |
| pnpm | 11.x | `packageManager` 字段锁定；Corepack 可直接启用 |
| FFmpeg / ffprobe | 6.x 及以上 | 逐帧渲染合成、音频混音、切片、delivery-check 响度校验均调用本机 ffmpeg |
| Chromium / Chrome | 最新稳定版 | 预览与导出共用同一渲染实现；`GLINT_CHROME_PATH` 可指定路径 |
| Rust 工具链 | stable | 仅 `apps/desktop`（Tauri 壳）需要 |

基本功能不依赖 Python；CSV/TSV 走内置解析，XLSX 导入和可选本地参考片 OCR 需要 Python，见 [资料与适配器](adapters.md)。

## 校验命令

```bash
node -v && pnpm -v && ffmpeg -version | head -1
pnpm exec tsc -b                      # 类型
pnpm verify:web                       # 真实服务门禁（队列/取消/幂等/Range）
pnpm --filter glint-web build         # 产物构建 + 首屏预算
```

## 环境变量

密钥类变量只从环境读取，服务端不会把明文回显给页面。全部为可选，未配置时对应能力显式降级并提示。

| 变量 | 作用 |
|---|---|
| `GLINT_LLM_BASE_URL` / `GLINT_LLM_API_KEY` / `GLINT_LLM_MODEL` / `GLINT_LLM_PROTOCOL` | 文本模型（策划、转写、智能体）。也可在页面模型设置里配置，持久化到服务端本地文件（0600） |
| `GLINT_LLM_REASONING_EFFORT` | 文本模型推理力度 |
| `GLINT_MEDIA_BASE_URL` / `GLINT_MEDIA_API_KEY` / `GLINT_MEDIA_PROTOCOL` | 媒体网关（图/音/视频生成） |
| `GLINT_MEDIA_PUBLIC_DNS` | TUN/Fake-IP 环境下载结果失败时，走公共 DNS 解析重试；不关闭 SSRF 防护 |
| `GLINT_SOURCE_PUBLIC_DNS` | 设为 `1` 时，Web 资料链接使用公共 DNS；域名会发送给该服务，解析结果仍检查公网地址并固定连接 |
| `GLINT_TABLE_PYTHON` | XLSX 解析使用的 Python 3 可执行文件；不设置时使用 `python` |
| `GLINT_REFERENCE_OCR_PYTHON` | 可选参考片 OCR 的可信 Python 可执行文件绝对路径；未设置时 OCR 不可用 |
| `GLINT_DATA_DIR` | 数据目录（生成素材、缓存、作业回执）；默认在系统临时目录下的工作子目录 |
| `GLINT_SESSION_DIR` | 共享工程会话存储目录；默认 `apps/studio/out/.sessions/` |
| `GLINT_PORT` / `PORT` | Web 服务端口（默认 4175） |
| `GLINT_PUBLIC_HOST` / `GLINT_ACCESS_TOKEN` / `GLINT_PUBLIC_AUTH` | 公网部署的域名、访问令牌与鉴权开关，见 [部署](deployment.md) |
| `GLINT_CHROME_PATH` | 渲染所用浏览器可执行文件路径 |
| `GLINT_TTS_OFFLINE` | 离线 TTS 引擎开关 |
| `GLINT_BROWSER_UI_TEST` | 显式开启浏览器 UI 测试（默认跳过） |

数据目录、备份与保留策略见 [数据生命周期](data-lifecycle.md)。
