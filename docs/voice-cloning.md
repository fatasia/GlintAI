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

## 自动验证

```bash
pnpm verify:voice --extended --python=/path/to/python --model=/path/to/model --reference=/path/to/reference.wav
python scripts/verify-voice-asr.py --help
```

验证使用独立临时缓存，先生成新音频，再检查第二次缓存命中和字节一致。PCM16 波形检查包括时长、RMS、有效音频占比、峰值削波与首尾静音；不能只凭文件非空判定有声音。

长旁白按句子拆成不超过 180 字的块，复用参考 prompt，块间加入 120ms 停顿；保留全部非空白文字，防止长段尾部丢失。过大峰值限制增益，非有限值和完全静音直接报错。

自动识别用独立的 Whisper-small、CPU int8、显式中英语言。中文只给简体提示，不给预期正文；比较前仅做 NFKC、大小写和标点归一化，不替换同音字或数字。默认阈值：中文 CER ≤10%，英文 WER ≤15%。识别误差和合成误差无法完全分开。

在 Windows、RTX 4060 Laptop 8 GB、Qwen 0.6B Base 上，官方参考录音的 5 段新推理样本均通过波形与识别阈值。长中文样本约 49.32 秒，推理约 83.72 秒，PyTorch allocated 显存峰值约 2609 MiB；英文样本约 10.48 秒、推理约 17.84 秒。这里只记录固定样本，不外推其他硬件。

同模型 speaker encoder 的 cosine 仅用于诊断，不能证明声音相似度或自然度。人工试听仍需实际听者；工作台提供本地 A/B 听评，不自动填写分数。

更多云端 TTS 与音色配置见 [模型与媒体服务](providers.md)。
