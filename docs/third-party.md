# 第三方组件

Glint 自有代码使用 Apache-2.0。下表记录本机安装包的声明，发行时需保留依赖与素材各自的许可文件。

| 组件 | 核对版本 | 包内声明 |
|---|---|---|
| Remotion | 4.0.536 | 自定义许可证，见其 LICENSE.md |
| GSAP | 3.15.0 | Standard no-charge license，不是 BSD/MIT |
| Three.js | 0.180.0 | MIT |
| React | 19.3.1 | MIT |
| msedge-tts | 2.1.0 | MIT；不替代语音服务本身的条款 |
| Qwen TTS（可选） | 0.1.1 | Apache-2.0；模型与参考音频单独管理 |

这是直接组件的元数据清单，不是全部传递依赖的法律审计。Remotion 的免费使用资格和公司许可条件请读随包条款；GSAP 请读其 [官方许可](https://gsap.com/standard-license/)。模型、字体、图片、语音、音乐和 3D 素材不因 Glint 的许可证而自动获得授权。

`examples/local-media` 的小型立方体为项目原创 fixture；DRACO 版本由同一立方体通过 Three 随包编码器生成。编码器和解码器来自安装依赖，不把第三方实现改写为自有代码。公开演示参考录音仅下载到可选本地运行时，不随 Glint 分发。

新增依赖：Lottie-web 5.13.0（MIT，使用无表达式 light Canvas 构建）、TypeScript 5.9.3（Apache-2.0）、esbuild 0.25.12（MIT）。可选本地 OCR 使用 RapidOCR 1.4.4；转录使用 faster-whisper 1.2.1 + PyAV 15.1.0，模型与 Python 二进制留在仓库外。Python 包、模型和媒体编解码依赖仍需按各自随包许可管理。

原创 KTX2 棋盘纹理由 Binomial 官方 Basis Universal 编码器生成，版本、原始字节 SHA-256 与上游 Git tree 对照保存在 `examples/local-media/encoder-provenance.json`；不分发编码器二进制。Lottie 矩形动画和 Three 方块代码均为项目测试素材。
