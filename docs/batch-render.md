# 批量渲染

需要连续导出多个项目时，用一个长期运行的 Node worker 复用 bundle 和浏览器。每个任务仍创建独立渲染页面；不是跨任务复用 React 页面。

```bash
pnpm glint render-worker --batch=jobs.json
```

```json
[
  {"id":"cover","args":["--project=lecture.json","--format=png","--frame=10","--out=cover.png"]},
  {"id":"video","args":["--project=lecture.json","--tts=sapi","--music=off","--fast","--out=lecture.mp4"]}
]
```

清单中的路径相对清单目录；支持 1..100 项。单个任务失败返回 error 回执，其他有效任务可继续；进程最终以非零码提示曾有失败。任务 ID 不可重复。

不传清单时，从 stdin 按 JSONL 接收同样的对象，输出每项的 JSONL 完成回执；日志写到 stderr。发送 `{"type":"shutdown"}` 正常结束，EOF 也会结束。stdin 路径相对调用目录。单行最多 64 KiB，最多接收 1000 个任务。

worker 串行执行任务，每项仍可使用有界 TTS 并发及本地缓存。任务新增的不可变、带独立目录的素材会补入已存在的 bundle；修改源码、依赖或同名运行时后应重启 worker。退出时关闭浏览器。终止整个 worker 会中止当前任务，不提供跨进程任务队列或单项远程取消 API。

`pnpm verify:batch` 真正导出 PNG 和 MP4，断言两个任务完成且 bundle/browser 计数均为 1，并检查第二项新引入的模型素材。Web jobs 仍使用独立 CLI 进程，以保留当前的进程树取消隔离。
