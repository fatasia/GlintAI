# 数据源适配器

内置：UTF-8 Markdown/TXT、HTML、JSON、CSV、文本 PDF、HTTP(S) 文本/PDF。默认上限 10 MiB；网络读取有超时、重定向和私网/DNS 检查。CSV 保留行列，PDF 扫描件需要另做 OCR。

## Office（可选）

```bash
pnpm glint make --source=slides.pptx --office --tts=mock --music=off
```

需要本机 Python 3，使用标准库读取 DOCX 段落、PPTX 幻灯片文字、XLSX 单元格和缓存值。不开宏、不算公式、不访问外部关系，不还原版式、图表或嵌入媒体。ZIP 内容有大小与文件数量上限。未加 `--office` 时继续明确拒绝 Office 二进制。

API：`readSourceText(input, {adapters: officeSourceAdapters("python")})`。Office 适配器已用实际 ZIP/XML 小型文件测试；大型复杂文档需另验。

## OCR 与转录工具

主流程不自动下载大模型。用可信本地程序提供扩展名适配器，配置仅由操作者指定：

```json
{"png":{"command":"your-ocr-tool","args":["--glint-stdin"]},"wav":{"command":"your-transcriber","args":["--glint-stdin"]}}
```

```bash
pnpm glint make --source=scan.png --adapters=adapters.json --tts=mock --music=off
```

程序通过 stdin 接收 `{"extension":"png","base64":"..."}`，stdout 返回 UTF-8 文本，非零退出表示失败。命令通过 argv 执行，不经 shell；输出上限 10 MiB，读取取消会传给子进程。工具若另开进程，应自行处理取消与资源释放。

配置文件能执行本机程序，不能采用资料里附带的命令。程序、模型、音色及账号由使用者安装和授权；测试用协议程序不代表已验收某家 OCR/转录模型。

API 也可直接注册 `SourceAdapter` 函数。图片作为画面素材与 OCR 是两件事，音频作为配音与转录同样分开。

## 本地 OCR / Whisper（可选）

使用独立 Python 环境安装 `packages/knowledge/adapters/requirements.txt`。当前固定 RapidOCR 1.4.4、faster-whisper 1.2.1、PyAV 15.1.0；PyAV 19 移除了该转录版本使用的参数，不能直接无上限升级。

```bash
python -m pip install -r packages/knowledge/adapters/requirements.txt
python scripts/setup-media.py --runtime-dir=D:/GlintRuntime/media
pnpm glint make --source=scan.png --media-python=D:/GlintRuntime/media/venv/Scripts/python.exe --tts=mock --music=off
pnpm glint make --source=recording.wav --media-python=D:/GlintRuntime/media/venv/Scripts/python.exe --transcription-model=D:/GlintRuntime/media/whisper-tiny --tts=mock --music=off
```

模型只在显式下载脚本中取得；渲染时离线读取本地文件。RapidOCR 使用安装包自带的中英文 ONNX 模型；Whisper tiny 在 CPU/int8 上运行，可从音频或视频的音轨转录。不上传媒体、不自动取账号凭据。图片最多 2000 万像素，音轨必须有可读取的时长且不超过十分钟；仍受 10 MiB 来源限制。当前不自动给扫描 PDF 的每页做 OCR。

`mediaSourceAdapters({python,modelDir})` 可直接用于 API。适配器是可选 Python 文件，不增加主 Node 安装的模型体积。

真实小样验证：一张含中文的讲解图识别出标题和字幕；三段 Qwen 合成音频经 Whisper tiny 转录，中文 CER 为 2/22、7/140，英文 WER 为 0/30。短语音和清晰字幕不代表扫描件、方言、噪声、复杂表格或长视频的准确率。

`pnpm verify:media --python=... --model=... --suite=suite.json` 接受本地测试清单：

```json
{"images":[{"file":"D:/checks/image.png","contains":"标题"}],"audio":[{"file":"D:/checks/speech.wav","text":"原始文字","language":"zh"}]}
```

输出实际识别结果与 CER/WER。该分数同时包含合成及识别误差，不是独立的配音人工听评。
