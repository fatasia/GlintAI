# 本地媒体回归素材

这些小型素材为项目自制测试数据：同一立方体的 glTF/GLB、DRACO 网格、ETC1S KTX2 棋盘纹理，以及简单的 GSAP、Lottie 和 Three 代码动画。

- `generate-draco.mjs` 使用安装的 Three 随包编码器生成原创立方体压缩网格。
- `generate-ktx2.mjs <本地 basis_encoder.js>` 使用 Binomial 官方 WASM 编码器生成 64×64 棋盘纹理。编码器不进仓库；版本与字节摘要见 `encoder-provenance.json`。
- `readiness.scenescript.json` 包含 7 个场景，每场景 12 帧，共 84 帧、24 fps、3.5 秒。CLI 重新配音时会按实际音频调整时长。

```bash
node examples/local-media/generate-draco.mjs
node examples/local-media/generate-ktx2.mjs D:/tools/basis_encoder.js
pnpm verify:render
```

KTX2 不是空壳或未压缩 RGBA 容器：它包含 ETC1S/BasisLZ 数据和七级 mip；真实 GLTFLoader/KTX2Loader 转码在渲染回归中执行。Lottie 数据是项目自制矩形动画，不含外部媒体或表达式。
