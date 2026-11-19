import { useEffect, useMemo, useRef, useState } from "react";
import { buildDesignPreview, DESIGN_BRIDGE, readDesignBridgeMessage, type DesignBridgeMessage } from "./design-editor-bridge";
import type { DesignAnnotation } from "./design-artifacts";
import { brandTokens, type BrandTheme } from "./design-brand";
import { useAuthoringVisible } from "./authoring-visibility";
export const designViewports = { desktop: { title: "桌面", width: 1280, height: 800 }, tablet: { title: "平板", width: 768, height: 1024 }, mobile: { title: "手机", width: 390, height: 844 }, slides: { title: "幻灯片", width: 1280, height: 720 } };
export type InlineDesignText = { text: string; x: number; y: number; width: number; height: number; onChange(text: string): void; onApply(): void; onCancel(): void };
const themeKeys = ["--ink-0", "--ink-1", "--ink-2", "--ink-3", "--ink-4", "--paper", "--paper-dim", "--muted", "--faint", "--accent", "--accent-ink", "--line-1", "--line-2", "--line-3", "--r-sm", "--r-md", "--font-ui"];
function usePreviewTheme() {
  const [theme, setTheme] = useState(0);
  useEffect(() => { const observer = new MutationObserver(() => setTheme(value => value + 1)); observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style"] }); return () => observer.disconnect(); }, []);
  return theme;
}
export function DesignPreview({ html, viewport, interactive, selected, commentMode = false, annotations = [], brand, onMessage, onAnnotation, inlineText, pageIds = [], stepReveal = false }: { html: string; pageIds?: string[]; viewport: keyof typeof designViewports; interactive: boolean; selected: string[]; commentMode?: boolean; annotations?: DesignAnnotation[]; brand?: BrandTheme | null; onMessage: (message: DesignBridgeMessage) => void; onAnnotation?(id: string): void; inlineText?: InlineDesignText; stepReveal?: boolean }) {
  const host = useRef<HTMLDivElement>(null), frame = useRef<HTMLIFrameElement>(null), callback = useRef(onMessage), annotationCallback = useRef(onAnnotation), marks = useRef(annotations);
  callback.current = onMessage; annotationCallback.current = onAnnotation; marks.current = annotations;
  const [width, setWidth] = useState(720), [ready, setReady] = useState(false), [failed, setFailed] = useState(false), theme = usePreviewTheme();
  const active = useAuthoringVisible();
  const pageSignature=JSON.stringify(pageIds);
  const generation = useMemo(() => crypto.randomUUID(), [active, html, interactive, commentMode, theme, pageSignature, brand?.accent, brand?.bg, brand?.text, brand?.displayFont]);
  const source = useMemo(() => {
    const style = getComputedStyle(document.documentElement);
    const base = Object.fromEntries(themeKeys.map(key => [key, style.getPropertyValue(key).trim()]));
    return buildDesignPreview(html, generation, interactive, { ...base, ...brandTokens(brand ?? null) }, commentMode, pageIds, stepReveal && interactive);
  }, [html, generation, interactive, commentMode, brand?.accent, brand?.bg, brand?.text, brand?.displayFont, stepReveal]);
  const size = designViewports[viewport], scale = Math.min(1, Math.max(0.15, (width - 24) / size.width));
  useEffect(() => {
    const resize = () => setWidth(host.current?.clientWidth || 720); resize();
    if (typeof ResizeObserver === "undefined") { window.addEventListener("resize", resize); return () => window.removeEventListener("resize", resize); }
    const observer = new ResizeObserver(resize); if (host.current) observer.observe(host.current); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setReady(false); setFailed(false);
    if (!active) return;
    const listener = (event: MessageEvent) => {
      const message = readDesignBridgeMessage(event, frame.current?.contentWindow ?? null, generation); if (!message) return;
      if (message.action === "ready") { clearTimeout(timeout); clearInterval(handshake); setReady(true); setFailed(false); }
      if (message.action === "annotation") { if (marks.current.some(mark => mark.id === message.annotationId)) annotationCallback.current?.(message.annotationId!); return; }
      callback.current(message);
    };
    window.addEventListener("message", listener);
    const handshake = setInterval(() => frame.current?.contentWindow?.postMessage({ type: DESIGN_BRIDGE, generation, action: "hello" }, "*"), 300);
    const timeout = setTimeout(() => { clearInterval(handshake); setFailed(true); }, 8000);
    return () => { clearInterval(handshake); clearTimeout(timeout); window.removeEventListener("message", listener); };
  }, [generation, active]);
  useEffect(() => { frame.current?.contentWindow?.postMessage({ type: DESIGN_BRIDGE, generation, action: "highlight", nodeIds: selected }, "*"); }, [selected, generation, ready]);
  useEffect(() => { frame.current?.contentWindow?.postMessage({ type: DESIGN_BRIDGE, generation, action: "annotations", annotations: annotations.map(({ id, x, y, text }) => ({ id, x, y, text })) }, "*"); }, [annotations, generation, ready]);
  return <div className="design-preview-host" ref={host}>
    <div className="design-preview-caption"><span>{size.title} · {size.width} × {size.height}</span><span>{commentMode ? "批注模式 · 点位置留意见" : interactive ? "交互预览" : "点选编辑"} · {Math.round(scale * 100)}%</span></div>
    {!ready && <div className="design-preview-loading" role={failed ? "alert" : "status"}>{!active ? "预览已暂停；返回后重新运行页面交互，编辑草稿保留。" : failed ? "隔离预览未响应；请切换源码后返回重试。草稿仍保留，复杂脚本可能阻塞预览。" : "正在准备隔离预览…"}</div>}
    <div className="design-preview-fit" style={{ position: "relative", width: size.width * scale, height: size.height * scale }}>
      {active && <iframe ref={frame} title="设计预览" sandbox="allow-scripts" srcDoc={source} data-design-generation={generation} style={{ width: size.width, height: size.height, transform: `scale(${scale})`, transformOrigin: "top left" }} />}
      {inlineText && <div className="design-inline-text" style={{position:"absolute",zIndex:2,left:Math.max(0,Math.min(inlineText.x*scale,size.width*scale-180)),top:Math.max(0,Math.min(inlineText.y*scale,size.height*scale-130)),width:Math.min(size.width*scale,Math.max(180,inlineText.width*scale)),padding:8,background:"var(--ink-2)",border:"2px solid var(--accent)",borderRadius:8}}>
        <textarea autoFocus aria-label="画面文字直接编辑" value={inlineText.text} maxLength={20000} style={{boxSizing:"border-box",width:"100%",minHeight:72,font:"inherit",color:"var(--paper)",background:"var(--ink-2)"}}
          onChange={event=>inlineText.onChange(event.target.value)} onKeyDown={event=>{if(event.nativeEvent.isComposing)return;if(event.key==="Escape"){event.stopPropagation();inlineText.onCancel();}else if((event.ctrlKey||event.metaKey)&&event.key==="Enter"){event.preventDefault();inlineText.onApply();}}}/>
        <div className="design-panel-actions"><button type="button" onClick={inlineText.onApply}>应用文字</button><button type="button" onClick={inlineText.onCancel}>取消直接编辑</button></div>
      </div>}
    </div>
  </div>;
}

/** Static, script-isolated thumbnail used by the scheme comparison grid. */
export function DesignThumb({ html, title, brand, viewport = "desktop" }: { html: string; title: string; brand?: BrandTheme | null; viewport?: keyof typeof designViewports }) {
  const active = useAuthoringVisible();
  const host = useRef<HTMLDivElement>(null), [width, setWidth] = useState(0), theme = usePreviewTheme();
  const generation = useMemo(() => crypto.randomUUID(), [html, theme, brand?.accent, brand?.bg, brand?.text, brand?.displayFont]);
  const source = useMemo(() => {
    const style = getComputedStyle(document.documentElement);
    return buildDesignPreview(html, generation, false, { ...Object.fromEntries(themeKeys.map(key => [key, style.getPropertyValue(key).trim()])), ...brandTokens(brand ?? null) }, false);
  }, [html, generation, brand?.accent, brand?.bg, brand?.text, brand?.displayFont]);
  const size = designViewports[viewport], scale = width / size.width;
  useEffect(() => {
    const resize = () => setWidth(host.current?.clientWidth ?? 0); resize();
    if (typeof ResizeObserver === "undefined") { window.addEventListener("resize", resize); return () => window.removeEventListener("resize", resize); }
    const observer = new ResizeObserver(resize); if (host.current) observer.observe(host.current); return () => observer.disconnect();
  }, []);
  return <div className="design-thumb-viewport" ref={host} style={{ aspectRatio: `${size.width} / ${size.height}` }}>
    {active && <iframe className="design-thumb-frame" title={title} sandbox="allow-scripts" srcDoc={source} loading="lazy" tabIndex={-1}
      style={{ width: size.width, height: size.height, transform: `scale(${scale})` }} />}
  </div>;
}
