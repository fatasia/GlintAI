# 离线准备测试夹具

默认回归需要四个历史参考视频、十套风格样片与 Windows secure-assets 两个构建。先安装锁定依赖，准备本地 FFmpeg、ffprobe、Chromium 和 Rust 离线缓存。

```sh
pnpm prepare:test-fixtures --stages=goldens --goldens=/path/to/goldens
pnpm prepare:test-fixtures --stages=bridges
pnpm prepare:test-fixtures --stages=styles --chrome=/path/to/chrome
pnpm test
```

`goldens` 目录只读，直接包含 whiteboard.mp4、blackboard.mp4、dark.mp4、lottie.mp4。SHA 来自已跟踪的 `apps/studio/scripts/reference-eval-fixtures.json`；没有外置包时此阶段失败。四个媒体尚未批准入库，准备命令不下载它们。

`styles` 调用已有真实风格样片生成器：mock TTS、无配乐、并发 1，最多 30 分钟。可用 `--styles=whiteboard` 验证一个风格；这不能满足完整回归。部分集合完成后不能在原目录扩充，使用另一个干净克隆准备全套，防止生成器覆盖已有 manifest。每个阶段显式选择；没有默认全量任务。

`bridges` 仅 Windows，分别用 `cargo build --offline --locked` 构建 debug 和 release，每次最多 10 分钟。缺缓存直接失败。模型凭据和外部运行时覆盖从子进程环境移除；不安装依赖或自动获取浏览器。

准备结果记录在 `outputs/test-fixtures/`，风格 manifest 保持原格式。已有带摘要的产物只校验；损坏、未登记或失败留下的部分产物不会覆盖。失败现场保留，需要修复前置并使用新克隆；不自动删除目录。运行中独占锁阻止第二个准备器；进程被外部强杀后的锁应先确认没有运行进程，再由操作者处理。

这些准备步骤不代替原测试，也不证明不同机器编码字节完全一致。黄金视频固定原字节；重新生成样片及桥程序记录本次实际摘要。

## CI 的显式金标来源

完整测试 job 在测试前准备金标、十套样片；Windows 还准备 debug/release secure bridge。无需模型凭据，缺少金标配置会停止，不跳过测试。

负责人配置以下仓库变量之一，不能同时设置：

- `GLINT_CI_GOLDENS_DIR`：runner 已存在的目录，内含 whiteboard.mp4、blackboard.mp4、dark.mp4、lottie.mp4。未来批准夹具入库后可指向对应本地目录。
- `GLINT_CI_GOLDENS_URLS`：JSON 对象，键必须恰为 `whiteboard`、`blackboard`、`dark`、`lottie-single-shot`；值为负责人选择的公开 HTTPS 直链，不含账号密码、查询参数或片段。不提供默认下载地址。

SHA256 固定来自 `apps/studio/scripts/reference-eval-fixtures.json`，不能通过变量更改。下载复用公共 HTTPS/DNS 固定与大小限制，每份最终还须不超过 1MiB；临时文件独占创建，校验后交 Q26 安装，原文件不覆盖。不支持 ZIP、签名查询链接或认证下载。

本地接线检查：`node scripts/prepare-ci-fixtures.mjs goldens`；设置 `GLINT_CHROME_PATH` 后运行 `node scripts/prepare-ci-fixtures.mjs runtime`。Windows 需先安装 stable Rust，并对 secure-assets 执行 `cargo +stable fetch --locked`，Q26 的后续构建保持 offline。CI 原有 20/30 分钟上限不变；远端执行需要负责人配置来源并推送。
