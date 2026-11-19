# HTML、Lottie 与 Three 动画

`kind: "html"` 可承载静态 HTML，或用 `animation: "gsap" | "lottie" | "three"` 接入按帧动画。运行时随安装依赖复制到本机，不依赖 CDN；GSAP、Lottie 和 Three 使用锁文件中固定的版本，按 README 使用 `pnpm install --frozen-lockfile`。锁文件完整性校验不等于运行时资源隔离或对本机文件篡改的防护。原创示例见 `examples/local-media/readiness.scenescript.json`。

## 本地参数化模板

CLI 可给已有工程追加一个可编辑的海报动效，再调整标题、副标题、颜色和入场时间：

```bash
pnpm glint html-template --project=project.json --scene=poster --append --headline="产品发布" --accent="#e94c36" --out=poster.json
pnpm glint html-template --project=poster.json --scene=poster
pnpm glint html-template --project=poster.json --scene=poster --headline="新标题" --duration-ms=1200 --out=poster-v2.json
pnpm glint render --project=poster-v2.json --out=poster.mp4 --tts=mock --music=off
```

输出文件必须与原工程同目录且不存在。修改视觉标题不会自动改旁白；模板 HTML 被手动编辑或镜头锁定时，命令会拒绝覆盖。模板适用于可信本地 CLI，Web 编辑器和 Web 渲染仍拒绝 HTML 场景。

## 本地 Lottie 导入

本机参数编辑台（不在页面播放或执行素材）：

```bash
pnpm glint lottie-studio --project=project.json --scene=animation --source=animation.json
# 编辑已导入镜头时省略 --source
pnpm glint lottie-studio --project=animation-project.json --scene=animation
```

按终端给出的地址打开本机编辑台，选择顶层图层、填写需修改的属性并保存为同目录新工程；原工程和素材不覆盖。编辑前若源工程或素材被其他操作修改，保存会拒绝并提示刷新。切换图层会提示确认丢弃当前图层尚未保存的修改。编辑台仅监听 127.0.0.1，地址中的会话令牌应保密；Ctrl+C 关闭。页面不提供播放预览，最终效果需通过可信本地渲染检查；Web 服务仍不接受 HTML / Three 场景。

```bash
pnpm glint lottie-import --inspect-source=animation.json
pnpm glint lottie-import --project=project.json --scene=animation --append --source=animation.json --out=animation-project.json
pnpm glint lottie-import --project=animation-project.json --scene=animation
pnpm glint lottie-import --project=animation-project.json --scene=animation --speed=1.5 --scale=1.2 --opacity=0.8 --out=animation-v2.json
pnpm glint lottie-import --project=animation-v2.json --scene=animation --layer-index=0 --layer-opacity=25 --out=animation-v3.json
pnpm glint lottie-import --project=animation-v2.json --scene=animation --layer-index=0 --layer-text="新标题" --out=animation-text.json
pnpm glint lottie-import --project=animation-v2.json --scene=animation --layer-index=0 --opacity-keyframe=1 --keyframe-frame=18 --out=animation-moved.json
pnpm glint lottie-import --project=animation-v2.json --scene=animation --layer-index=0 --position-keyframe=1 --keyframe-pos=300,140 --out=animation-position.json
pnpm glint render-native --project=animation-v2.json --scenes=animation --out=animation.mp4 --fast --tts=mock --music=off
```

`--inspect-source` 在导入前只读检查源文件，输出尺寸、帧率和顶层图层能力清单，不执行动画、不写入工程；它使用与导入相同的受限校验，但不是完整 Lottie 兼容性或安全认证。检查必须单独运行，不能与编辑参数组合。

速度和缩放范围 0.25–4，整体透明度范围 0–1；调整后动画不能超过当前镜长。检查命令列出顶层图层、可编辑静态变换、静态填充及符合格式的透明度/位置关键帧；索引均从 0 开始。`--layer-opacity` 为 0–100，不能覆盖动画关键帧；`--fill-path` 和 `--fill-color` 仅修改静态填充。对已有透明度关键帧使用 `--opacity-keyframe` 配合 `--keyframe-opacity` 修改值，或配合 `--keyframe-frame` 移动时间；后者使用源动画帧，须在 `[ip, op)` 内且严格位于相邻关键帧之间，不插入、删除或重排关键帧。对已有位置关键帧使用 `--position-keyframe` 配合 `--keyframe-pos=<x,y>` 修改值：只改 x/y 并保留 z 维、时间、缓动与空间切线；前一关键帧带旧式 `e` 终值时会校验一致并同步，不能与 `--layer-pos` 同用，分割维度（`p.x`/`p.y`）不支持。其他属性关键帧暂不支持。顶层文字图层仅支持编辑唯一静态文字记录（`--layer-text`，可为空，最多 4096 UTF-8 字节）；文字关键帧或不支持的结构会被拒绝，原有动画和样式保留。使用系统字体或素材内自带字形，缺失字形可能影响显示。仅支持小于 256 KiB、无表达式的 Lottie JSON；图片必须是内嵌 PNG/JPEG/WebP，不支持外链、SVG 图片或外部字体路径。导入会创建 HTML 场景，不转换成逐层可编辑对象；手动修改生成的 HTML 或锁定镜头后，参数命令拒绝覆盖。Web 仍拒绝不可信 HTML 场景。

## 动画合同

- GSAP：`window.__glintTimeline = gsap => gsap.timeline({paused:true})...`，每帧执行绝对 seek，抑制回调并停止 ticker。
- Lottie：把动画 JSON 赋给 `window.__glintLottie`；使用本机完整 Lottie 播放器；含文字图层时使用 SVG，其余使用 Canvas，关闭 autoplay/loop/subframe，先复位再定位整数动画帧。导入校验禁止表达式，但本机自定义 HTML 并非不可信代码沙箱。不是 After Effects 全功能执行器。
- Three：提供下面的工厂。框架创建保留绘图缓冲的 renderer，每帧调用 `seek(t)`、绘制并等待 GPU 完成。工厂不创建第二个 renderer 或动画循环。

```html
<script>
window.__glintThree = (THREE, {width, height}) => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, width / height, .1, 100);
  camera.position.z = 4;
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshNormalMaterial());
  scene.add(mesh);
  return {scene, camera, seek(t) { mesh.rotation.set(t, t * 2, 0); }};
};
</script>
```

`t` 是场景内的秒数。工厂和 seek 必须是确定性的：不使用墙钟、随机数、CSS 动画、网络请求或持续累加状态。自定义 GLSL 和 Three 场景代码可在该合同内运行，不支持运行 Node.js、任意 npm 导入或外部脚本。

## 资源与隔离

HTML 放在双层不授予 same-origin 的 iframe 中。可信外层只转发带 generation 的帧协议，并用独立 CSP 限制内层导航；不修改承载 Glint 的宿主页 CSP。内层禁用 connect、外部图片/字体/媒体、嵌套 iframe、worker、object、form 和 base，脚本只允许内联代码及框架选定的本机运行时。图片可内嵌 data URL，字体可内嵌 data URL；glTF/KTX2 走独立本地素材管线。

静态 HTML 的内层不授予脚本权限。动画内层允许脚本，等待资源及布局提交后才回执；错误、超时和被阻止的导航使导出失败。

这不是通用敌对代码执行服务：死循环、内存/显卡耗尽、浏览器漏洞、隐蔽信道及任意创作代码的确定性不在保证范围内。只执行操作者信任的本地场景。资源隔离回归覆盖 fetch/XHR/beacon、图片、CSS、脚本、iframe、worker、表单、父 DOM 与自身导航探针。

## 可编辑图表

`kind: "chart"` 支持 `chartType: "bar" | "line"`、`heading`、`unit` 与 `data: [{label, value}]`。数值必须来自资料，不由绘图组件推断；示例见 `examples/charts/project.scenescript.json`，其中数据明确标为虚构。

支持正负数和零值，超过六项分页，最多 24 项。柱高和折线位置均由帧计算，不依赖播放历史；编辑器可改类型、标签、数值和旁白。自然语言修改只作用于指定分镜。

## 同 ID 矩形形变

相邻两个内置场景的 `elements` 含同 ID 矩形时，在第二场景设置 `transition: {"in":"shape-morph","durationMs":1000}`，位置、宽高、圆角和颜色会从前一场景的形状平滑变为后一场景；时间由帧决定，随机跳帧不改变结果。项目的分辨率由 `aspect` 决定，两个场景共用同一画布。该入口目前通过 SceneScript JSON 配置，尚无专用的可视化转场控件。

首版要求形状 ID 在各场景内唯一，且至少有一组同 ID 矩形；两个场景均不使用非静态摄像机、节拍脉冲或效果，同 ID 形状不带关键帧；前一场景没有入场转场，当前场景不重叠。HTML、Three、图片和视频场景不支持此转场。无字幕干净版导出按现有规则隐藏对象层。

## 可编辑矢量笔触

内置场景的色块可在「对象与关键帧 → 形态」切换为「矢量笔触」，复用位置、宽高、颜色与现有关键帧。它是固定轮廓，不支持自由画笔或真实颜料模拟；笔触模式下圆角不生效。HTML、Three、图片、视频场景暂不支持此形态；笔触参与矩形形变时，两端须选择相同形态。
