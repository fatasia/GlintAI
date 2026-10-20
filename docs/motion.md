# HTML、Lottie 与 Three 动画

`kind: "html"` 可承载静态 HTML，或用 `animation: "gsap" | "lottie" | "three"` 接入按帧动画。运行时随安装依赖复制到本机，不依赖 CDN。原创示例见 `examples/local-media/readiness.scenescript.json`。

## 动画合同

- GSAP：`window.__glintTimeline = gsap => gsap.timeline({paused:true})...`，每帧执行绝对 seek，抑制回调并停止 ticker。
- Lottie：把动画 JSON 赋给 `window.__glintLottie`；使用无表达式的 light Canvas 构建，关闭 autoplay/loop/subframe，先复位再定位整数动画帧。不是 After Effects 全功能执行器。
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
