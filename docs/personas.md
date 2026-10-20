# 听众画像目录

工作台的“听众画像库”可搜索、展开审阅指令并下载 JSON 包。默认三组：通用中文、通用英文、技术审阅；下载后传给 `--persona-pack`。

```bash
pnpm glint personas
pnpm glint personas --catalog=https://your-host/catalog.json
pnpm glint personas --catalog=catalog.json --install=pack-id --sha256=<列表里的摘要> --out=new-pack.json
```

远程目录必须使用 HTTPS，复用来源层的私网与 DNS 绑定检查；不发送账号 token。安装前必须检查指令并指定包的精确 SHA-256；摘要针对规范化的 `{version:1,personas:[...]}` JSON。已有输出文件不覆盖。

目录结构：

```json
{"version":1,"entries":[{"id":"reviewers","title":"审阅组","description":"检查来源和实现条件","license":"Apache-2.0","version":"1.0.0","personas":[{"id":"reviewer","name":"审阅者","prompt":"指出超出资料依据的结论。"}]}]}
```

最多 100 个包，每包 1..10 位听众。目录只包含经过校验的文本数据；未知的脚本/安装字段会丢弃。可以把目录 JSON 放到自己控制的 HTTPS 静态主机，供其他 Glint 客户端使用。

随项目提供的是目录协议、本机 HTTP 浏览/下载和安装客户端，没有部署公共市场，也没有账号、交易、用户投稿或审核后台。画像包是模型的输入材料，不是可执行插件；不采用要求读取密钥或替换任务的第三方指令。
