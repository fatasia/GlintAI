# Docker 部署

用于一台 Linux 服务器上的单用户工作台。建议至少 2 CPU、2 GB 可用内存和 5 GB 可用磁盘；已有应用时先检查实际余量。镜像包含 Chromium、FFmpeg、Git 和中文字体，不下载 Python 或 GPU 模型。支持独立域名或 `/glint/` 子路径，不占用其他应用的根路径或 API。

## 启动

在仓库根目录执行：

```bash
cp .env.example deploy/.env
chmod 600 deploy/.env
# 编辑 deploy/.env：GLINT_PUBLIC_HOST=你的域名；GLINT_PUBLIC_AUTH=1 时再配置 GLINT_ACCESS_TOKEN
docker compose --env-file deploy/.env -p glint -f deploy/compose.yml up -d --build
docker compose --env-file deploy/.env -p glint -f deploy/compose.yml ps
curl --fail http://127.0.0.1:4180/healthz
```

`GLINT_PUBLIC_HOST` 只填准确主机名，不填协议、路径或多个域名。生产默认建议 `GLINT_PUBLIC_AUTH=1`，外部访问使用 HTTP Basic，用户名 `glint`、密码为访问令牌。若设置 `GLINT_PUBLIC_AUTH=0`，页面和 API 无需登录即可进入；这会把内容、生成额度和模型接口暴露给能访问该地址的人，只适合受控网络或另有网关鉴权的场景。`/healthz` 仅返回存活状态。

需要通过站点提供 Windows 客户端时，将已验收的 ZIP 只读挂载到容器，并把 `GLINT_DESKTOP_DOWNLOAD_FILE` 设为容器内该 ZIP 的绝对路径。首页和文档会自动切换为直接下载；未配置或文件不可用时链接到 GitHub Releases。此配置不会打包或发布客户端，升级站点前须自行核验包版本、签名状态和校验值。

如果服务器已有 80/443 业务，可用独立端口运行：

```yaml
services:
  glint:
    ports: !override
      - "0.0.0.0:4180:4175"
```

然后访问 `http://服务器IP:4180/`。腾讯云安全组还必须放行 TCP 4180；宿主防火墙和 Docker 监听正常，不代表云安全组已放行。不要把 Glint 的入口直接改成已有站点的默认 IP/HTTPS server。

默认绑定宿主 `127.0.0.1:4180`，不占用现有 80/443。容器以非 root 运行，限制内存、CPU、进程数和日志大小，默认只运行一个生成任务。小内存服务器可在环境中设置 `GLINT_RENDER_CONCURRENCY=1`（显式 CLI 参数优先）；重型 Three / WebGL 项目可能需要更高资源。

Compose 使用随仓库提供的 [Chromium seccomp 配置](../deploy/chromium-seccomp.md)，允许浏览器在容器内建立自己的沙箱。部署后应检查 `chrome://sandbox` 和一次真实导出；只通过 HTTP 健康检查不代表渲染可用。

## 挂载到已有站点的 `/glint/`

在 `deploy/.env` 设置 `GLINT_WEB_BASE_PATH=/glint/`，并按上述命令重新构建。构建与运行时必须使用同一路径；桌面客户端仍使用 `/`。在原有 Nginx 站点中只增加以下 location，不替换整份站点配置：

```nginx
location = /glint { return 308 /glint/; }
location ^~ /glint/ {
    proxy_pass http://127.0.0.1:4180;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    client_max_body_size 301m;
    proxy_buffering off;
    proxy_read_timeout 300s;
}
```

`proxy_pass` 不加末尾 `/`，保留子路径给 Glint。验证 `/glint/api/health`、图片预览、重新打开工程和下载；原站点的 `/api/` 不应指向 Glint。已有根路径版与子路径版的离线缓存名称独立，切换路径仍需核对浏览器中的已有项目。

跨区域连接 Debian 源超时时，可用 `docker build --build-arg DEBIAN_MIRROR=http://mirrors.cloud.tencent.com -t glint:local .` 指定就近镜像；Debian 包签名检查保持启用。默认仍使用 Debian 上游，不替换宿主源。

## HTTPS 反向代理

宿主 Nginx 的独立虚拟主机示例：

```nginx
server {
    listen 443 ssl;
    server_name glint.example.com;
    ssl_certificate /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;
    client_max_body_size 301m;
    location / {
        proxy_pass http://127.0.0.1:4180;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_buffering off;
        proxy_read_timeout 300s;
    }
}
```

Nginx 如果也在容器内，不要把它的 `127.0.0.1` 当作宿主：把两者加入专用共享 Docker 网络，再代理到 Glint 的容器别名和 4175 端口。修改已有代理前备份配置、执行 `nginx -t`，通过后再 reload，不能覆盖其他项目的虚拟主机。

证书可通过 [Certbot webroot](https://eff-certbot.readthedocs.io/en/stable/using.html#webroot) 在不停止现有 HTTP 服务的情况下签发。配置续期、证书部署和 reload；用 staging / dry-run 检查流程，避免反复签发触发限额。

没有域名时，可使用 [Let's Encrypt IP 证书](https://letsencrypt.org/2026/03/11/shorter-certs-certbot)：Certbot 5.4+ 的 `--ip-address` 与 `--preferred-profile shortlived` 支持 webroot。证书约六天有效，必须配置自动续期和代理 reload；HTTP 挑战需按准确 IP Host 路由。若共用 443，应为 IP 证书明确配置默认 TLS 虚拟主机，同时保留原域名的 SNI 配置。

## 数据、更新与回滚

`glint-projects` 卷包含任务、项目来源、素材与成片；`glint-cache` 卷保存语音和渲染缓存。若在环境变量中自定义 `GLINT_DATA_DIR` 或 `GLINT_SESSION_DIR`，路径必须位于持久卷内，或另外挂载持久卷，否则容器重建后数据可能丢失。两者都可能包含用户内容。删除服务不会删除卷，勿在保留数据时使用 `down -v`。

更新前备份 `.env` 和两个卷，并记录当前镜像 ID 与 Git 提交。使用固定提交构建，不把密钥、宿主 `node_modules`、输出目录或模型权重传入构建上下文。升级后验证：

1. 无认证访问返回 401，错误 Host 返回 403，健康探针正常。
2. 模型连接测试、离线编排、实际视频生成与 Range 下载正常。
3. 重启后已完成任务可查询，未完成任务标为中断，不自动重试付费请求。
4. 原有站点和服务仍可访问，磁盘与内存余量正常。

回滚使用保留的镜像重建 Glint 容器，再验证任务与代理；不删除数据卷。不要通过全局 `docker system prune` 清理共享服务器。

参考：[Docker Compose 生产部署](https://docs.docker.com/compose/how-tos/production/)。

## 发布前本机容器验收

先构建与部署路径一致的镜像，再启动隔离测试：

```sh
docker build --build-arg GLINT_WEB_BASE_PATH=/glint/ -t glint:acceptance .
node scripts/verify-container.mjs glint:acceptance /glint/
```

脚本只使用本机现有镜像，在随机 loopback 端口启动临时容器，配置临时 Basic 认证；检查页面、真实 Chromium 沙箱、中文视频生成及 FFprobe 信息。报告、容器日志和 MP4 写入临时证据目录，退出删除测试容器，不挂载业务数据卷。用例使用无声 mock 配音，语音与真实模型生成应另行验收。

浏览器检查使用构建后的固定副本及隔离服务。可运行整套，也可传入具体测试文件：

```sh
pnpm --filter glint-web build
pnpm verify:browser
pnpm verify:browser -- apps/web/server/creation-flow.browser.test.ts
```

历史风格样片须预先生成到 `outputs/style-samples`；报告保留实际跳过项，不将其计为通过。
