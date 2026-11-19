# 数据源适配器

内置：UTF-8 Markdown/TXT、HTML、JSON、CSV、文本 PDF、HTTP(S) 文本/PDF。默认上限 10 MiB；网络读取有超时、重定向和私网/DNS 检查。CSV 保留行列，PDF 扫描件需要另做 OCR。

Web 高级编辑可先预览 TXT/Markdown 本地正文、公开 HTTPS 链接，或把 CSV/TSV/XLSX 表格预览为可编辑图表工程。文本文件上限 256 KiB、12000 字符；XLSX 上限 2 MiB，可选择工作表，需服务端 Python 3，只读取缓存值，不执行公式或宏。无缓存值的公式和错误单元格会被拒绝；布尔值转为 TRUE/FALSE，日期保留时间，并遵循工作簿的 1900 或 1904 日期系统。链接提取正文上限 12000 字符，扫描 PDF 不含 OCR。图表最多显示 24 行，超出时会提示截断。链接读取不会自动提交模型。TUN/Fake-IP 环境可为服务显式设置 `GLINT_SOURCE_PUBLIC_DNS=1`：域名发送到公共 DNS，但私网地址和重定向仍经过检查。

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

### 参考片画面文字

服务端可设置 `GLINT_REFERENCE_OCR_PYTHON` 为本机可信 Python 可执行文件的绝对路径；该环境须安装 RapidOCR 1.4.4、Pillow 与 NumPy。重启 Web 服务后，在参考片面板显式勾选本机画面文字识别。未勾选不会启动 OCR；没有配置或识别失败时仍可生成参考工程。

Windows x64 可使用独立 Python 3.12 环境，安装 `apps/web/server/requirements-reference-ocr-win-py312.txt` 中的验收版本（例如在新虚拟环境中运行 `python -m pip install --only-binary=:all: -r apps/web/server/requirements-reference-ocr-win-py312.txt`），然后将该环境的 `Scripts/python.exe` 绝对路径设置到服务进程的 `GLINT_REFERENCE_OCR_PYTHON`。配置不自动写入系统环境；临时命令窗口设置仅对该窗口启动的服务有效。其他系统需自行验证兼容版本。

每镜取接近中点的一帧，仅在页面展示文字、请求采样时间和模型分数；不上传媒体、不自动写入旁白或发给模型。请求时间不是精确帧时间或逐字时间码，模型分数也不是校准准确率。单次最多 12 镜，帧图及返回内容受大小和时间限制。

真实小样验证：一张含中文的讲解图识别出标题和字幕；三段 Qwen 合成音频经 Whisper tiny 转录，中文 CER 为 2/22、7/140，英文 WER 为 0/30。短语音和清晰字幕不代表扫描件、方言、噪声、复杂表格或长视频的准确率。

`pnpm verify:media --python=... --model=... --suite=suite.json` 接受本地测试清单：

```json
{"images":[{"file":"D:/checks/image.png","contains":"标题"}],"audio":[{"file":"D:/checks/speech.wav","text":"原始文字","language":"zh"}]}
```

输出实际识别结果与 CER/WER。该分数同时包含合成及识别误差，不是独立的配音人工听评。
