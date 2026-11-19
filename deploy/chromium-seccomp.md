# Chromium 容器沙箱

`chromium-seccomp.json` 来自 [Playwright 官方 Docker 配置](https://playwright.dev/docs/docker#crawling-and-scraping)，基于 Docker 默认 seccomp 规则，允许 Chromium 创建用户命名空间。保留非 root 用户和 `no-new-privileges`，不增加 `SYS_ADMIN`，不使用 `--no-sandbox`。

- 上游固定版本：[ae935a43](https://github.com/microsoft/playwright/blob/ae935a43d9e376e4759548f6b3c6905c7b282333/utils/docker/seccomp_profile.json)
- SHA-256：`cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849`
- 上游许可证：Apache-2.0（[许可证](https://github.com/microsoft/playwright/blob/ae935a43d9e376e4759548f6b3c6905c7b282333/LICENSE)）。

2026-11-01，本机 Docker Desktop Linux 容器实测：Chromium 156 启动，`chrome://sandbox` 显示 Namespace、PID/Network namespaces、Seccomp-BPF 与 TSYNC 启用。服务器内核及 AppArmor 策略可能不同；部署验收必须在目标机器重新检查，不通过时不要禁用沙箱继续上线。
