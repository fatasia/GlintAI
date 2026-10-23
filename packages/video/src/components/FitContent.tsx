import { useLayoutEffect, useRef } from "react";
import { cancelRender, continueRender, delayRender } from "remotion";
export function contentScale(availableWidth: number, availableHeight: number, width: number, height: number) {
  return Math.min(1, availableWidth / Math.max(1, width), availableHeight / Math.max(1, height));
}
/** Fit the natural content box inside the reserved scene area, after font layout. */
export function FitContent({ children, centered }: { children: React.ReactNode; centered: boolean }) {
  const outer = useRef<HTMLDivElement>(null), inner = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const handle = delayRender("glint-content-layout");
    let live = true, released = false, first = 0, second = 0;
    const release = () => { if (!released) { released = true; continueRender(handle); } };
    const fit = () => {
      if (!live || !outer.current || !inner.current) return;
      const scale = contentScale(outer.current.clientWidth, outer.current.clientHeight, inner.current.scrollWidth, inner.current.scrollHeight);
      inner.current.style.transform = `translate(-50%, -50%) scale(${scale})`;
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    if (observer) { observer.observe(outer.current!); observer.observe(inner.current!); } else window.addEventListener("resize", fit);
    document.fonts?.addEventListener("loadingdone", fit);
    Promise.resolve(document.fonts?.ready).then(() => {
      if (!live) return;
      first = requestAnimationFrame(() => { fit(); second = requestAnimationFrame(release); });
    }).catch((error) => { if (live) cancelRender(error); });
    return () => {
      live = false; observer?.disconnect(); window.removeEventListener("resize", fit); document.fonts?.removeEventListener("loadingdone", fit);
      cancelAnimationFrame(first); cancelAnimationFrame(second); release();
    };
  }, []);
  return <div ref={outer} data-glint-content style={{ position: "relative", width: "100%", height: "100%", minHeight: 0 }}>
    <div ref={inner} style={{ position: "absolute", left: "50%", top: "50%", width: "100%", transform: "translate(-50%, -50%)", transformOrigin: "center", display: "flex", flexDirection: "column", alignItems: centered ? "center" : "flex-start", gap: 52, overflowWrap: "anywhere" }}>{children}</div>
  </div>;
}
