// K-03 影响预测文案:预览只读,不发起执行;本地渲染与 AIGC 并列陈述,不偏向任何一方。
export const planPreviewMessages = {
  "planPreview.title": "影响预览",
  "planPreview.unavailable": "影响预览暂不可用",
  "planPreview.objects": "影响对象：{count} 个文档",
  "planPreview.nodes": "将重建 {predicted} 个节点，复用 {reused} 个",
  "planPreview.time": "预计耗时约 {seconds}",
  "planPreview.timeUnknown": "预计耗时未知，以回执实测对照",
  "planPreview.costLocal": "费用类型：本地渲染（MG 或已生成素材，免费但有时延）",
  "planPreview.costQuote": "{count} 个 AIGC 镜头需先走媒体报价并批准后再执行；本地渲染部分免费",
  "planPreview.timeline": "剪辑导出：{clips} 个片段 · 时长 {seconds} 秒（导出走专用管线，耗时以实测对照）",
  "planPreview.actual": "预测 vs 实际：预计约 {estimated} 秒，实际 {actual} 秒",
  "planPreview.actualTimeline": "预测 vs 实际：{clips} 个片段 · 时长 {seconds} 秒，导出实际耗时 {actual} 秒",
} as const;
