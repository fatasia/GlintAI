# 渲染回归

`pnpm verify:render` 验证中文、glTF/GLB、真实 DRACO、真实 ETC1S KTX2、GSAP、Lottie light Canvas 和自定义 Three 工厂。需要项目依赖、FFmpeg 和 Remotion 使用的 Chrome；不调用模型或 TTS。

```bash
pnpm verify:render
pnpm verify:render --scale=1
pnpm verify:render --out=D:/GlintChecks
```

默认半尺寸 960×540；`--scale=1` 为 1920×1080。输出父目录必须位于仓库外，默认使用系统临时目录。失败返回非零码，保留报告和已产生的帧图。

## 像素检查

使用 `examples/local-media/readiness.scenescript.json` 的 7 场景、3.5 秒、24 fps fixture。一次 bundle、复用浏览器；PNG 解码为 RGBA 后比较 SHA-256，不比较压缩文件大小。

- 顺序渲染两遍，每遍 84 帧，逐帧要求完整 RGBA 一致。
- 固定种子的 22 次冷页面乱序采样，包括重复目标帧，与顺序基线比较。
- 另在一个浏览器文档中，用 Remotion `Freeze` 驱动随机帧上下文，完整回访 84 帧并重复两帧，共 86 帧。并发固定 1，记录文档 timeOrigin，断言只使用一个文档；每帧要求完整 RGBA 与基线一致。
- 场景区域可见与变化检查排除字幕、进度条、水印；GSAP 另与冻结时间轴反例比较，避免仅靠字幕变化通过。

同文档测试覆盖组件收到乱序/重复帧时的状态行为；它不是直接操纵 Web Player seek API 的测试。Remotion `renderFrames({frames})` 本身会排序，本脚本没有把排序后的帧号冒称随机 seek。结果仅适用于当次系统、字体、浏览器与图形后端，不代表跨设备像素一致。

## 失败与隔离检查

缺工厂、seek 抛错、坏图片和坏字体必须让导出失败。HTML 资源探针另检查 fetch/XHR/beacon、图片、CSS、脚本、iframe、worker、表单、父 DOM 和自身导航；本机计数服务器必须没有收到请求。被阻止的自身导航会使场景失败，不放行错误页面。

这是一组有明确范围的浏览器隔离回归，不是通用敌对代码执行服务的安全证明。执行合同与限制见[动画说明](motion.md)。

## 就绪约定

字体保持内容挂载，等待字体请求与 `document.fonts.ready`；StrictMode 重放、主题切换各自持有门控句柄。失败调用 `cancelRender`。

HTML 从挂载开始阻挡采集。可信外层转发 generation/requestId 协议；内层完成绝对 seek、资源检查和布局提交后才回执，外层再等两次绘制提交后转发。父层校验当前 iframe 窗口、世代、请求与时间。静态 HTML 内层禁用脚本。

glTF 先预取经过校验的本地依赖，并在解析前把 URI 映射到 blob，覆盖拥有独立 LoadingManager 的 KTX2 扩展加载器；纹理解码为空也失败。异步模型挂载后显式绘制、等待 GPU，再释放门控，保留绘图缓冲供静帧采集。

根背景使用纯色，减少大面积 CSS 渐变瓦片边缘的非稳定栅格差异；嵌入动画不叠加父层透明度入场。Lottie 使用清屏 Canvas 构建，复位后按相对整数帧定位，避免 SVG 冷启动与顺序路径的边缘差异。像素断言没有增加容差或缩小比较区域。
