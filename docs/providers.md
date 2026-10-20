# 模型与媒体服务

账号配置在服务端；浏览器不保存密钥。`.env.example` 是变量清单，Node 命令不会自动加载它：在 shell 设置环境变量，或由 Docker Compose 的 `env_file` 加载。

## 文本模型

| 变量 | 用途 |
|---|---|
| `GLINT_LLM_BASE_URL` | HTTPS 服务地址，或显式 loopback HTTP 本地服务 |
| `GLINT_LLM_API_KEY` | 对应服务的密钥 |
| `GLINT_LLM_MODEL` | 模型 ID；不要求出现在列表中 |
| `GLINT_LLM_PROTOCOL` | `auto`、`openai`、`responses`、`anthropic`、`gemini` |
| `GLINT_LLM_REASONING_EFFORT` | 可选 `low/high/max`，仅配置给支持该参数的模型 |

工作台「模型连接」支持读取列表、手输模型、保存和一次真实调用测试。更换地址必须重新输入密钥，避免把旧服务的凭据发给新地址。页面保存仅影响当前进程，重启使用环境配置。

自动适配先根据服务和模型提示选择协议，只在明确端点不兼容时换协议；认证、配额、服务器错误和超时不触发轮询式试探。模型列表属于服务元数据，不证明网关别名的真实上游。没有列表接口时可手输模型。

OpenAI / Anthropic 已支持流式问答；首次自动探测以及 Responses / Gemini 当前以完整响应返回。可手动指定协议避开探测。

## 配音

| 引擎 | 服务端配置 | 字幕时间 |
|---|---|---|
| `mock` | 无，无声草稿 | 文本估计 |
| `sapi` | Windows 系统音色 | 估计 |
| `edge` | 联网 Edge | 引擎边界 |
| `qwen` | 本地 Python、模型、授权参考录音 | 真实时长 + 估计 |
| `openai` | `GLINT_TTS_BASE_URL/API_KEY/MODEL/VOICE` | 真实时长 + 估计 |
| `elevenlabs` | `GLINT_ELEVENLABS_API_KEY/VOICE/MODEL` | 服务返回字符对齐 |
| `fish` | `GLINT_FISH_API_KEY/VOICE/MODEL` | 真实时长 + 估计 |
| `minimax` | `GLINT_MINIMAX_API_KEY/VOICE/TTS_MODEL` | 真实时长 + 估计 |
| `gateway` | `GLINT_MEDIA_BASE_URL/API_KEY/TTS_MODEL/TTS_VOICE` | 真实时长 + 估计 |

编辑器可设置每场音色 ID 和语速，先试听再导出。Qwen 固定参考音色，网关 TTS 当前只接受原始语速；不支持的选项会报错。云端音色与模型是否可用取决于账号，不自动上传录音或创建声音克隆。

ElevenLabs、Fish、MiniMax 官方适配器使用各自官方接口和密钥。媒体网关不是官方账号的替代地址；不要跨服务复用 Key。接口参考：[ElevenLabs](https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps)、[Fish](https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech)、[MiniMax](https://platform.minimax.io/docs/api-reference/speech-t2a-http)。

## 图片、短视频与音乐

素材工坊读取网关的可用模型，提交异步任务、恢复查询、下载到服务器素材库。高级 JSON 参数支持服务文档中的参考图片、模型选项和音色 ID；只有提交时才发送给网关。它不是 Fotor 官方账号，也不自动猜测各模型的编辑参数。

```bash
pnpm glint media --list=audio
pnpm glint media --voices=gem-3.1-tts
pnpm glint media --model=suno-v6 --prompt="Instrumental ambient background, no vocals" --params=music-params.json --out=out/music.mp3
# 已经提交的任务只恢复查询，不再生成
pnpm glint media --task=TASK_ID --out=out/music.mp3
```

`music-params.json` 示例（LK 网关）：

```json
{"make_instrumental":"instrumental","mv":"v6-mini"}
```

Suno 通过明确配置的网关调用，不是 Suno 官方公开 API。生成一次后，在工作台背景配乐中选保存的 MP3/WAV；重复导出复用素材。也可导入自己从 Suno 导出的文件：

```bash
pnpm glint render --project=project.json --music=/path/to/music.mp3
```

CLI 另外支持 `--music=auto`（本地氛围音）、`off`、`minimax`（官方音乐账号）、`gateway`（按环境参数新生成，可能每次计费）。音乐均混入成片，默认低音量并淡入淡出。

提交回执不确定时不自动重发。工作台保留 requestId 和最近任务；查询失败可恢复，网关已经收到的任务不能通过关闭页面取消。素材下载限制为 10 MiB，超出时可在服务自己的结果页下载，再用 CLI 导入。

TUN / Fake-IP 导致公共素材解析到保留地址时，可显式设置 `GLINT_MEDIA_PUBLIC_DNS=1`。它使用公共 DNS，所有地址仍需经过公共 IP 检查和固定连接；普通服务器不需要设置。
