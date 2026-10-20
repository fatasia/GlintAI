# 代码走读与界面采集

`--code=<目录>` 做有限静态扫描，不启动项目。需要语义调用关系时：

```bash
pnpm glint code-graph --code=../repo --out=out/code-graph.json
```

图来自 TypeScript TypeChecker：最多 12 个已扫描的 TS/JS 源文件，输出函数位置、可静态解析的调用边及未解析表达式。导入仅解析这批文件，不读取 node_modules、全局库或仓库外文件；不执行代码。动态派发、反射、外部依赖和运行时覆盖没有被推断成已知边。Python/Rust/Go 仍只有静态摘要。

## 显式启动配置

```bash
pnpm glint preview-code --code=../repo --preview-config=preview.json --out=out/capture-context.json
```

```json
{"command":"node","args":["server.mjs"],"url":"http://127.0.0.1:4300","ttlMs":600000}
```

仅采用操作者明确指定的可执行程序和参数数组，不猜启动脚本，不自动安装依赖。Windows 使用实际可执行文件；包管理器的 `.cmd` 应改成对应 Node 入口。可选 `env` 对象只用于该进程，不能把凭据写入公开配置。

启动目录是 `--code`。URL 必须是带明确端口的本机 HTTP 地址；已响应的端口会被拒绝。启动后最多等待 45 秒，成功输出 ready、URL 和上下文路径；上下文同时带静态调用图。默认十分钟后结束，或向 stdin 写入内容/Ctrl+C 停止整棵启动进程树。目标程序的原始日志不展示在公共回执中。

## Agent 采集路径

Agent 读取 ready URL，在当前允许的浏览器工具中打开并操作目标页面，检查真实可见状态后保存截图。把选用截图复制到讲解项目的 `assets/`，用 image 场景引用，再使用静态调用图中的真实文件/行号写说明。截图本身不能证明业务流程或运行时调用关系。

任意项目仍需提供其正确启动命令、依赖及测试数据。没有一条命令能可靠推断所有项目的启动方法；当前没有内置浏览器脚本录制器。`verify:preview` 用真实本机子进程验证启动、HTTP 就绪、上下文生成及进程树停止；本次 Glint 自身工作台另已做浏览器操作与截图。
