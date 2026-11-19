# 几何预演控制图

为已有 PrevizDoc 导出一个镜头帧的程序几何 RGB、深度和法线图，供人工检查或后续控制工作流使用。

```sh
node skills/glint-video/scripts/glint.mjs --root=<runtime> previz-controls --document=scene.previz.json --shot=shot --frame=0 --out=controls-new --width=320 --near=0.1 --far=100
```

源仓库也可用 `pnpm glint previz-controls ...`。相对路径按调用者目录解释；本机 Chromium/Chrome 和运行时依赖须已安装。输出目录必须不存在，父目录必须存在。成功输出 JSON，失败退出非 0。取消用 Ctrl+C。本命令不提交生成模型、不下载资产，不修改输入工程。

- `--frame` 为镜头内从 0 开始的帧序号，按文档 fps 与已有相机插值求值；`--shot` 为镜头 ID。
- `--width` 默认 320，按文档画幅计算高度；两边均须 16–2048 像素。输入 JSON 限 2 MiB。
- 支持舞台和 box/cylinder/sphere，圆柱直径由 width/depth 定义，球按尺寸缩放。含 actor 或 model 的文档直接拒绝；不输出骨架、姿势或未知资产替身。
- `rgb.png` 是固定程序配色；`depth.png` 为相机前向距离的 **8 位线性灰度**，near 白、far 黑、背景黑；`normal.png` 将视空间 XYZ 法线按 `(n+1)/2` 编码为 RGB8。
- `controls.json` 保存相机、near/far（米）、帧时间、输出大小与哈希。深度量化、抗锯齿混合和背景/远裁面同值限制均需保留，不能当作 16 位距离数据。没有自动接入 ComfyUI。

最小输入（相机局部时间从镜头起点计）：

```json
{"schemaVersion":1,"id":"demo","title":"Geometry","aspect":"16:9","fps":24,"stage":{"width":10,"depth":10},"actors":[],"props":[{"id":"cube","name":"Cube","shape":"box","position":[0,0,0],"size":[2,2,2]}],"cameras":[{"id":"camera","name":"Camera","keys":[{"tMs":0,"position":[4,3,6],"target":{"point":[0,1,0]}}]}],"shots":[{"id":"shot","cameraId":"camera","startMs":0,"endMs":1000,"subjectIds":[]}]}
```
