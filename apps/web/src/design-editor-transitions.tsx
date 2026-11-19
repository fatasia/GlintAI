import { useEffect, useRef } from "react";
import { DESIGN_TRANSITION_MAX_MS, DESIGN_TRANSITION_MIN_MS, DESIGN_TRANSITION_TYPES, designTransitionLabels, transitionInStyle, transitionOutStyle, transitionSheetCss, type DesignTransition } from "./design-transition";
import type { DesignPage, DesignPageTransition } from "./design-artifacts";
import { DesignPreview } from "./design-editor-preview";
import type { DesignBridgeMessage } from "./design-editor-bridge";
import type { BrandTheme } from "./design-brand";

const DURATIONS = [200, 300, 500, 800, 1200];

/** Rail block for the active page; edits go through the caller so history stays uniform. */
export function DesignTransitionControls({ page, pages, slides, onChange, onApplyAll, onPreview }: {
  page: DesignPage;
  pages: DesignPage[];
  slides: boolean;
  onChange(patch: { transition?: DesignPageTransition; stepReveal?: boolean }): void;
  onApplyAll(transition: DesignPageTransition): void;
  onPreview(): void;
}) {
  const transition = page.transition, type = transition?.type ?? "none";
  const index = pages.findIndex(item => item.id === page.id);
  const previewable = type !== "none" && index > 0 && pages.length > 1;
  const durations = [...new Set([...DURATIONS, transition?.durationMs ?? 300])].sort((a, b) => a - b)
    .filter(value => value >= DESIGN_TRANSITION_MIN_MS && value <= DESIGN_TRANSITION_MAX_MS);
  return <section className="design-transition-panel" aria-label="页面转场">
    <div className="design-panel-head"><strong>页面转场</strong><span>进入本页时播放</span></div>
    <label>方式<select aria-label="页面转场方式" value={type} onChange={event => onChange({ transition: { type: event.target.value as DesignTransition["type"], durationMs: transition?.durationMs ?? 300 } })}>
      {DESIGN_TRANSITION_TYPES.map(value => <option key={value} value={value}>{designTransitionLabels[value]}</option>)}
    </select></label>
    <label>时长<select aria-label="页面转场时长" value={transition?.durationMs ?? 300} onChange={event => onChange({ transition: { type, durationMs: Number(event.target.value) } })}>
      {durations.map(value => <option key={value} value={value}>{value} ms</option>)}
    </select></label>
    <div className="design-transition-actions">
      <button type="button" title={previewable ? "播放 上一页 → 本页 的转场效果，不改文档" : "需要本页设置转场且不是第一页"} disabled={!previewable} onClick={onPreview}>试播转场</button>
      <button type="button" title="把当前方式与时长应用到全部页，可一次撤销" onClick={() => onApplyAll({ type, durationMs: transition?.durationMs ?? 300 })}>应用到全部页</button>
    </div>
    {slides && <label className="design-step-reveal">
      <input type="checkbox" aria-label="逐步展示" checked={page.stepReveal ?? false} onChange={event => onChange({ stepReveal: event.target.checked })} />
      逐步展示 · 演示时点击逐个显示入场对象
    </label>}
  </section>;
}

export type TransitionPlay = { from: DesignPage; to: DesignPage; transition: DesignTransition };
/** Two stacked page frames sharing one grid cell; the incoming page animates on top, then the caller commits. */
export function DesignTransitionPlayer({ play, interactive, onMessage, onFinished, brand }: {
  play: TransitionPlay;
  interactive: boolean;
  onMessage(message: DesignBridgeMessage): void;
  onFinished(): void;
  brand?: BrandTheme | null;
}) {
  const finished = useRef(false), callback = useRef(onMessage), complete = useRef(onFinished);
  const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  callback.current = onMessage; complete.current = onFinished;
  const finish = () => { if (!finished.current) { finished.current = true; complete.current(); } };
  // Safety net in case animationend never fires (reduced motion, hidden tab).
  useEffect(() => { const timer = setTimeout(finish, play.transition.durationMs + 1500); return () => clearTimeout(timer); }, [play]);
  // Animation strings stay imperative: dynamic keyframe/duration pairs cannot live in token classes.
  const applyAnimation = (node: HTMLDivElement | null, css: string) => { if (node && css && !reduced) node.style.animation = css.replace(/^animation:\s*/, ""); };
  const frameProps = (page: DesignPage, live: boolean) => ({
    html: page.html, viewport: "slides" as const, interactive: live, selected: [], commentMode: false,
    annotations: page.annotations ?? [], brand, pageIds: [page.id],
    onMessage: live ? (message: DesignBridgeMessage) => callback.current(message) : () => { },
  });
  return <div className="design-transition-player" aria-label="页面转场播放">
    {/* Keyframes ship with the player: the animation names only exist while a transition plays. */}
    <style>{transitionSheetCss(play.transition.type)}</style>
    <div className="design-transition-frame" ref={node => applyAnimation(node, transitionOutStyle(play.transition.type, play.transition.durationMs))}>
      <DesignPreview {...frameProps(play.from, false)} />
    </div>
    <div className="design-transition-frame" ref={node => applyAnimation(node, transitionInStyle(play.transition.type, play.transition.durationMs))} onAnimationEnd={finish}>
      <DesignPreview {...frameProps(play.to, interactive)} />
    </div>
  </div>;
}
