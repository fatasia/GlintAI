import type { CSSProperties } from "react";
import type { ImageScene } from "@glintai/scenescript";

/** Keep the timed narration subtitle, but do not paint an identical hero label.
 * A clean plate omits the duplicate too; distinct visual copy is preserved. */
export function shouldShowImageCaption(scene: ImageScene): boolean {
  const caption = scene.caption?.trim();
  if (!caption) return false;
  if (scene.presentation !== "showcase" || caption !== scene.narration.text.trim()) return true;
  const words = scene.narration.segments?.flatMap(segment => segment.words ?? []) ?? [];
  // Timed words can differ from narration.text; then both texts carry information.
  return words.length > 0 && words.map(word => word.text).join("").trim() !== caption;
}

/** Shared geometry for the Remotion preview and the independent native capture. */
export function imageSceneLayout(scene: ImageScene, width: number, height: number) {
  const unit = Math.min(width, height) / 1080;
  if (scene.presentation === "slide") return {
    container: { position: "absolute", inset: 0, width: `${width}px`, height: `${height}px`, overflow: "hidden", background: "#101014" } as CSSProperties,
    background: undefined, veil: undefined,
    // Keep the full source page above the narration band, including its footer.
    frame: { position: "absolute", left: 0, top: 0, width: "100%", height: "80%" } as CSSProperties,
    image: { display: "block", width: "100%", height: "100%", objectFit: "contain" } as CSSProperties,
    caption: { position: "absolute", bottom: "5%", left: "8%", right: "8%", margin: 0, color: "white", textAlign: "center" } as CSSProperties,
  };
  if (scene.presentation === "showcase") return {
    container: { position: "absolute", left: "0", top: "0", width: `${width}px`, height: `${height}px`, overflow: "hidden" } as CSSProperties,
    background: { position: "absolute", inset: "0", width: "100%", height: "100%", objectFit: "cover", opacity: "0.36", filter: `blur(${24 * unit}px) saturate(0.8)`, transform: "scale(1.1)" } as CSSProperties,
    veil: { position: "absolute", inset: "0", background: "rgba(0,0,0,0.24)" } as CSSProperties,
    frame: { position: "absolute", left: "8%", top: "10%", width: "84%", height: "63%" } as CSSProperties,
    image: { display: "block", width: "100%", height: "100%", objectFit: "contain", filter: `drop-shadow(0 ${18 * unit}px ${32 * unit}px rgba(0,0,0,0.3))` } as CSSProperties,
    caption: { position: "absolute", left: "8%", right: "8%", top: "76%", maxHeight: "9%", overflow: "hidden", margin: "0", textAlign: "center", color: "#fff", fontFamily: "var(--glint-font-body)", fontSize: `calc(var(--glint-font-size-body) * ${unit})`, lineHeight: "1.25", textShadow: `0 ${2 * unit}px ${12 * unit}px rgba(0,0,0,0.8)`, overflowWrap: "anywhere" } as CSSProperties,
  };
  const top = Math.min(150 * unit, height * 0.14), bottom = Math.min(330 * unit, height * 0.31);
  const available = height - top - bottom - (scene.caption ? (44 + 136) * unit : 0);
  return {
    container: { position: "absolute", left: "0", top: "0", width: `${width}px`, height: `${height}px`, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: `${44 * unit}px`, padding: `${top}px ${Math.min(170 * unit, width * 0.09)}px ${bottom}px`, boxSizing: "border-box" } as CSSProperties,
    background: undefined, veil: undefined,
    frame: { width: "100%", maxWidth: `${1400 * unit}px`, height: `${Math.max(unit, Math.min(height * 420 / 1080, available))}px`, flexShrink: "0" } as CSSProperties,
    image: { display: "block", width: "100%", height: "100%", objectFit: "contain", boxSizing: "border-box", borderRadius: `calc(var(--glint-radius) * ${unit})`, boxShadow: "var(--glint-shadow-card)", border: `${unit}px solid color-mix(in srgb, var(--glint-color-text) 10%, transparent)` } as CSSProperties,
    caption: { width: "100%", maxWidth: `${1400 * unit}px`, flexShrink: "0", margin: "0", fontSize: `calc(var(--glint-font-size-body) * ${unit})`, color: "var(--glint-color-text-muted)", textAlign: "center", lineHeight: "1.35", overflowWrap: "anywhere" } as CSSProperties,
  };
}

/** Subtle foreground-only depth motion; scene camera and narration stay separate. */
export function showcaseForegroundTransform(scene: ImageScene, frame: number, durationFrames: number, unit = 1): string {
  if (scene.presentation !== "showcase" || !scene.camera || durationFrames <= 1) return "none";
  const progress = Math.max(0, Math.min(1, frame / (durationFrames - 1)));
  const amount = scene.camera.intensity ?? 0.5;
  if (scene.camera.type === "push") return `translateY(${((1 - progress) * amount * 10 * unit).toFixed(2)}px) scale(${(1 + progress * amount * 0.04).toFixed(4)})`;
  // Smooth endpoints avoid a jarring start/stop and are deterministic under seeking.
  const eased = progress * progress * (3 - 2 * progress);
  if (scene.camera.type === "pull") return `scale(${(1 + (1 - eased) * amount * 0.04).toFixed(4)})`;
  if (scene.camera.type === "pan-left" || scene.camera.type === "pan-right") {
    const direction = scene.camera.type === "pan-left" ? -1 : 1;
    return `translateX(${(direction * (eased - 0.5) * amount * 28 * unit).toFixed(2)}px)`;
  }
  return "none";
}
