export const nleRenderMessages = {
  "nleRender.options": "运动模糊",
  "nleRender.samples": "子帧采样",
  "nleRender.off": "关闭",
  "nleRender.sampleCount": "{count} 次",
  "nleRender.shutter": "快门角度",
  "nleRender.help":
    "只影响本次导出。开启后最多 720p，采样越多渲染越慢；4K 请关闭。透明导出仍仅支持文字和音频。",
  "nleRender.limit": "当前尺寸或时长超出运动模糊上限，请关闭模糊或调整工程。不会自动降低分辨率。",
  "nleRender.invalid": "请选择有效采样次数和 0 到 360 度之间的快门角度（不含 0）。",
  "nleRender.running": "正在渲染多轨成片…",
  "nleRender.runningAlpha": "正在渲染透明 WebM…",
  "nleRender.ready": "成片已生成 · {size} KB",
  "nleRender.failed": "NLE 渲染失败",
} as const;
