# 节拍展示片

`beat-showcase` 给产品与代码演示使用：大字卡和内容镜交替，软件创作库、CLI 与本 Skill 使用同一个内置包。

- 六镜、每镜四拍、84 BPM、30 FPS；全局拍点按帧量化，总长 514 帧（17.133 秒）。
- 开场 → 产品特点 → 转折字卡 → 代码 → 价值字卡 → 行动说明。
- 原生文字、代码、节拍标记与关键帧均可编辑，无素材下载、生成模型或付费调用。
- 创作库预览无声；默认合成配乐是本地 84 BPM 垫乐，第一小节以铺底为主，不是每拍都有鼓点。

## 最短路径

```bash
pnpm glint packs --use=beat-showcase --out=showcase.json
pnpm glint render-native --project=showcase.json --out=showcase.mp4 --tts=existing --music=synth
pnpm glint delivery-check --video=showcase.mp4 --audio=optional
```

这里 `--tts=existing` 保留工程时长。新包没有旁白音频，因此成片只有合成配乐；不要把它描述为语音生成。参考浏览器管线需显式 `--tts=mock --music=synth` 才保留时长（mock 表示静音旁白，不是生成语音）。真实 TTS 会重估镜头时长，之后必须重排并复核拍点，不能继续声称保持卡点。

合成配乐导出后仍需响度检查。本次默认样片为 -41.89 LUFS，未达到交付目标；显式两遍响度处理后为 -16.06 LUFS、-4.68 dBTP，检查通过。先用 FFmpeg `loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json` 测量，再把本次测量的 `input_i/input_tp/input_lra/input_thresh/target_offset` 分别填入第二遍的 `measured_I/measured_TP/measured_LRA/measured_thresh/offset`，保留视频流 `-c:v copy`，另存交付文件并重新运行 `delivery-check`。不要复用其他音频的测量值，也不要把原始导出视作已通过响度检查。

仓库外使用本 Skill 的 `scripts/glint.mjs --root=<仓库>` 入口代替 `pnpm glint`，参数和生成工程相同。

## 填入自己的内容

将输入保存为 `inputs.json`，加 `--params=inputs.json`：

```json
{
  "title": "让作品说话",
  "tagline": "用你自己的介绍替换",
  "productName": "你的作品",
  "feature1": "你的真实特点一",
  "feature2": "你的真实特点二",
  "statement": "不止于展示",
  "codeHeading": "核心实现",
  "code": "const idea = 'hello';",
  "value": "保持创造",
  "cta": "开始你的作品"
}
```

字卡保持短句；代码以一到三行短片段为宜，竖屏逐帧检查换行。默认文案是示例，不代表已核实的产品能力。若换用自己的音频，需要自行校准起拍和速度；同为 84 BPM 不代表起拍相同。镜头时长与动画均可编辑，但编辑后要重新检查节奏。

## 验证与来源

检查 16:9、9:16、1:1 的开场、代码和结尾帧；运行 `lint`、`qa`、`delivery-check`，区分技术结果与人工审美检查。节奏断言以原始 30 FPS 工程为准，换帧率后需要重新量化。

编排方向参考公开项目 `Moessif/code-video-showcase` 的展示片概念；本包独立实现，未使用其代码、提示词、音频或样片。
