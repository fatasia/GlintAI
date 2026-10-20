# 性能与体积

Glint 默认保留画质，用按需加载、受控并发和工作目录隔离缩短等待。以下是同机实测，不是全硬件保证。

## 2026-10-21 实测

Windows、Node 24.18.1、i9-12900HX。混合动画 fixture：960×540、24 fps、84 帧、无音轨、balanced CRF20/slow。每档两次，第二轮倒序；耗时不含首次 bundle。

| 渲染并发 | 平均渲染+编码 | MP4 大小 | PSNR |
|---|---:|---:|---:|
| 1 | 10.421 s | 197780 bytes | 47.618722 dB |
| 2 | 6.914 s | 197780 bytes | 47.618722 dB |
| 4（默认上限） | 6.579 s | 197780 bytes | 47.618722 dB |

1→4 并发耗时减少约 **36.9%**，六个 MP4 的 SHA-256 相同。其他素材、显卡、驱动可能不同；WebGL 重场景或内存紧张时可降到 1–2。

另外确认的改进：

- 播放器在点击预览后加载，修正 manualChunks 把共享 React 与 Player 提前打包的问题。首屏静态 JS 约 104 kB gzip，CI 上限 160 KiB；Three 延迟块仍约 940 kB，未将它从功能中删除。
- PWA 首次只预缓存轻量页面，播放器和示例素材在用过后缓存。服务端使用预生成 Brotli/gzip、ETag 和哈希资源长期缓存；构建检查会验证解压后字节一致。
- 每个渲染会话使用独立临时 public，不再复制历史任务的约 33.9 MB 素材；结束清理该会话的 public 与 bundle 目录。文字项目不准备动画解码器。
- 无声草稿直接计算字幕时长，不生成、缓存和解码静音 WAV；字幕时间与旧 MockTtsProvider 相同。
- 示例图片改为**无损** WebP：462973→272656 bytes，RGB PSNR 为 infinity。没有使用有损图片冒充原画质。

完整编辑项目实际导出：8.93 秒 / 268 帧，冷会话总计 11.54 秒，其中 bundle/浏览器约 3.74 秒、渲染编码约 6.29 秒；MP4 91480 bytes。该样本是无声文字项目，不代表克隆语音速度。

## 安装

```bash
pnpm install:fast
```

先 `pnpm fetch --frozen-lockfile`，再从本地 store 链接；锁文件未改时可直接 `pnpm install --offline --frozen-lockfile`。不下载 Python 模型或 Chrome，首次真正渲染仍可能下载浏览器。

新目录复用本地 store 的 registry-enabled 安装测得约 6.62 秒（验收禁用依赖脚本）；同目录已安装的离线检查曾测得 0.60 秒。两者都不是首次联网安装速度。冷安装取决于网络、磁盘与依赖缓存，不承诺固定时间。

## 画质/体积选择

| 档位 | 分辨率 | CRF / x264 | 用途 |
|---|---|---|---|
| draft | 50% | 24 / veryfast | 快速检查 |
| compact | 100% | 24 / slow | 小文件分享 |
| balanced | 100% | 20 / slow | 默认交付 |
| quality | 100% | 16 / slow | 母版 |

没有单一参数能同时得到最快、最小、最高画质。试过 compact/veryfast 后，样本 PSNR 从 46.89 降到 46.40 dB，速度收益不稳定，已撤回。不要把降低 CRF、分辨率或帧率当成无损提速。

```bash
pnpm benchmark:encoding '--concurrency=1,2,4' --profiles=balanced --repeats=2
pnpm verify:budget
pnpm glint render --project=project.json --encoding=balanced --concurrency=4
```

每个导出旁边生成 `<output>.metrics.json`，记录各阶段耗时、帧数、输出字节与会话复用次数，不含来源正文或凭据。批量任务用 [render-worker](batch-render.md) 复用 bundle 和浏览器。
