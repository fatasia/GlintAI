/**
 * TEAM-04 安全区：各画幅下文字/关键信息不应越出的边距（占画面宽/高的百分比）。
 * 参考线只在预览叠加显示；导出走 nle-render 的独立页面截图，永不含参考线。
 * 竖屏平台（抖音/快手/视频号）惯例：底部留出互动区、顶部留出状态栏；
 * 横屏与方形留窄边即可。画幅按 NLE 的宽高比推导（NleProject 不带 aspect 字段）。
 */
export interface SafeAreaInsets { top: number; bottom: number; left: number; right: number }

export function safeAreaInsets(project: { width: number; height: number }): SafeAreaInsets {
  const ratio = project.width / Math.max(1, project.height);
  if (ratio < 0.95) return { top: 0.12, bottom: 0.2, left: 0.05, right: 0.05 }; // 9:16 竖屏
  if (ratio < 1.05) return { top: 0.06, bottom: 0.12, left: 0.05, right: 0.05 }; // 1:1 方形
  return { top: 0.05, bottom: 0.06, left: 0.04, right: 0.04 }; // 16:9 横屏
}

/** Preview-only guide overlay; a sibling of the render host so exports never see it. */
export function SafeAreaOverlay({ insets }: { insets: SafeAreaInsets }) {
  const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
  return <div aria-label="安全区参考线" title="安全区：文字与关键信息保持在框内" style={{
    position: "absolute", pointerEvents: "none", inset: 0,
    top: pct(insets.top), bottom: pct(insets.bottom), left: pct(insets.left), right: pct(insets.right),
    border: "1.5px dashed rgba(148,163,184,.55)", borderRadius: 6,
  }} />;
}
