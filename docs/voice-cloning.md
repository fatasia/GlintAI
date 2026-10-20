# 本地语音克隆

选择 **Qwen3-TTS-12Hz-0.6B-Base** 作为可选本地方案。官方接口支持参考音频、对应文字，以及复用提取好的声音 prompt；中英文都在官方语言范围内。[官方代码与用法](https://github.com/QwenLM/Qwen3-TTS)、[模型卡](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-0.6B-Base)。

另查过 [Chatterbox Multilingual](https://github.com/resemble-ai/chatterbox) 和 [Fish Audio 克隆接口](https://docs.fish.audio/api-reference/endpoint/model/create-model)。前者也能本地多语言克隆；后者需要服务账号并上传音频。Glint 当前选择本地 Qwen，不自动上传参考录音。

## 可选环境

按官方说明在独立 Python 环境安装 `qwen-tts==0.1.1` 和匹配的 PyTorch/音频依赖，并提前下载官方 Base 模型。模型不进入 Node 安装包。Windows 可用 SDPA 路径，不强制安装 FlashAttention。

可在该环境中执行项目的可选下载脚本：

```bash
python scripts/setup-qwen.py --runtime-dir=D:/GlintRuntime/qwen --source=modelscope --official-demo
```

ModelScope 方式另需该环境安装 `modelscope`，也是 Qwen 官方列出的国内下载渠道；默认 Hugging Face 方式可省略 `--source`。脚本不登录账号，下载模型到仓库外。`--official-demo` 才下载官方参考录音；不使用该开关时自行提供本地录音。

```bash
pnpm glint make --source=source.md --tts=qwen --tts-python=C:/path/to/venv/Scripts/python.exe --tts-model=D:/models/Qwen3-TTS-0.6B-Base --reference-audio=D:/voices/reference.wav --tts-concurrency=1 --music=off
```

可加 `--reference-text="录音对应的原文"`。没有对应文字时使用官方的 x-vector-only 模式，克隆质量可能降低；这不是微调训练。

使用自己的或已授权的录音。测试参考来自官方模型卡链接的公开演示 `clone.wav`，不随项目分发；没有选用路人、名人或用户私有音频。

## 运行方式

`QwenLocalTtsProvider` 启动一个本地 Python worker，加载模型与参考 prompt 后复用到各个场景；请求通过 UTF-8 JSONL stdin/stdout，模型日志不进入 Web。Windows 不使用控制台默认 GBK 解码。worker 只接受本地模型路径，设置离线模式，不在渲染期间自动下载权重。取消或超时停止 worker 并拒绝未完成请求；调用方结束后 dispose。

音频按真实 WAV 时长回填，词级字幕时间仍是估计，不是语音识别对齐。当前使用固定参考声音与原始语速，不接受另一个 `voice` id 或非 1 的 speakingRate。

## 本机验证

```bash
pnpm verify:voice --python=C:/path/to/venv/Scripts/python.exe --model=D:/models/Qwen3-TTS-0.6B-Base --reference=D:/voices/reference.wav
```

该命令在临时目录保存真实 WAV、带配音的 MP4 和报告，再检查缓存字节一致、音频非静音及视频流。包内协议单测不加载模型。

2026-10-20 在 Windows、RTX 4060 Laptop 8 GB、Qwen 0.6B Base 上，使用官方演示录音、不提供对应文字的 x-vector-only 模式，完成中文单句合成和 MP4 导出：WAV 3.28 秒、157484 bytes；首次加载及合成约 14.0 秒，缓存读取约 2.4 ms。MP4 为 960×540、24 fps，包含 H.264 和 AAC。音频均值音量 -26.8 dB、峰值 -9.0 dB。

这是单句通路记录；后续长文本与资源测量见下。人工声音相似度听评未执行。参考音频与生成音频都只保存在本机，不随项目分发。

## 长文本与资源测量

给 `verify:voice` 加 `--extended` 会绕过样本缓存，在同一模型 worker 中生成中短句、中文段落及英文段落，并保存音频和诊断。

本机三段样本为 4.24 / 28.80 / 11.04 秒，推理耗时约 6.85 / 46.72 / 17.96 秒。PyTorch allocated 显存峰值约 2200 / 2609 / 2341 MiB，reserved 最大 3018 MiB；不是进程总显存或系统总占用。

同一 Qwen speaker encoder 的参考/生成 embedding cosine 为 0.9868 / 0.9865 / 0.9887。它是同模型诊断代理指标，不是独立说话人鉴定、人工相似度评分或身份验证。后续 Whisper tiny 转录的中文 CER 为 9.09% / 5.00%，英文 WER 为 0%；识别误差与合成误差不能据此分开。
