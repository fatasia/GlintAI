import { nleSampleMotion, nleTransitionProgress, sampleEffects, type NleClip, type NleProject } from "@glintai/scenescript";

/**
 * The NLE frame contract: one function draws the complete picture at t.
 *
 * It builds plain DOM (no framework, no Remotion) so the same code drives the
 * editor preview (requestAnimationFrame in the user's browser) and the render
 * (headless Chrome screenshots fed to ffmpeg). The rule matches the rest of
 * the repo: drawing t must not depend on what was drawn before, so seek order
 * never changes the picture. DOM and media elements persist in per-host pools;
 * visible state is fully re-derived on every call.
 */

export interface NleFrameHost {
  /** Persistent root element sized to the project; created once per host. */
  root: HTMLElement;
  /** Map a contract asset name ("assets/x.mp4") to a fetchable URL. */
  resolveAsset: (src: string) => string;
  /** Internal pools, created lazily and reused across frames. */
  layers?: Map<string, HTMLElement>;
  media?: Map<string, HTMLVideoElement | HTMLAudioElement>;
  images?: Map<string, HTMLImageElement>;
  /** Clip-local source targets written while drawing; read by syncNleMedia. */
  targets?: Map<string, number>;
  /** Currently audible/visible media clips, for play/pause decisions. */
  audible?: Set<string>;
}

/** CSS filter chain for the clip's colour effects at a local time. */
function effectFilter(clip: NleClip, localMs: number): string {
  return sampleEffects(clip.effects ?? [], localMs).map(effect => ({
    brightness: `brightness(${effect.value})`, contrast: `contrast(${effect.value})`,
    saturate: `saturate(${effect.value})`, grayscale: `grayscale(${effect.value})`,
    sepia: `sepia(${effect.value})`, hue: `hue-rotate(${effect.value}deg)`, blur: `blur(${effect.value}px)`,
  }[effect.kind])).filter(Boolean).join(" ");
}


const FONT_STACK = "system-ui,-apple-system,'Segoe UI','Microsoft YaHei','PingFang SC','Noto Sans CJK SC','WenQuanYi Zen Hei',sans-serif";

/**
 * Greedy wrap. CJK breaks between characters, Latin between tokens; a single
 * token wider than the box is sliced so a long word still renders.
 */
function wrapLines(context: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(String.fromCharCode(10))) {
    let line = '';
    const tokens = paragraph.match(/[A-Za-z0-9]+[ ]*|[^ ]/gu) ?? [];
    for (const token of tokens) {
      const next = line + token;
      if (line && context.measureText(next).width > maxWidth) { lines.push(line.trimEnd()); line = token.trimStart(); }
      else line = next;
      while (context.measureText(line).width > maxWidth && Array.from(line).length > 1) {
        let cut = line.length;
        while (cut > 1 && context.measureText(line.slice(0, cut)).width > maxWidth) cut--;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    lines.push(line.trimEnd());
  }
  return lines.length ? lines : [''];
}

function drawTextCanvas(canvas: HTMLCanvasElement, clip: Extract<NleClip, { kind: "text" }>, referenceHeight: number): void {
  const targetWidth = Math.max(16, Math.round(canvas.getBoundingClientRect().width || canvas.parentElement?.clientWidth || 1920));
  const targetHeight = Math.max(16, Math.round(canvas.getBoundingClientRect().height || canvas.parentElement?.clientHeight || 1080));
  if (canvas.width !== targetWidth || canvas.height !== targetHeight) { canvas.width = targetWidth; canvas.height = targetHeight; }
  const context = canvas.getContext("2d");
  if (!context) return;
  const size = (clip.fontSize ?? 64) * (targetHeight / referenceHeight);
  const weight = clip.weight ?? 700;
  context.clearRect(0, 0, targetWidth, targetHeight);
  context.font = `${weight} ${size}px ${FONT_STACK}`;
  context.fillStyle = clip.color ?? "#f4f4f5";
  context.textBaseline = "middle";
  const padding = targetWidth * 0.08;
  const lines = wrapLines(context, clip.text, targetWidth - padding * 2);
  const lineHeight = size * 1.35;
  const startY = targetHeight / 2 - (lines.length - 1) * lineHeight / 2;
  lines.forEach((line, index) => {
    const y = startY + index * lineHeight;
    if (clip.align === "left") { context.textAlign = "left"; context.fillText(line, padding, y); }
    else if (clip.align === "right") { context.textAlign = "right"; context.fillText(line, targetWidth - padding, y); }
    else { context.textAlign = "center"; context.fillText(line, targetWidth / 2, y); }
  });
}

/** Combined style for a clip at a local time: transition × keyframe motion × mask. */
export function nleClipStyle(clip: NleClip, localMs: number): { opacity: number; transform: string; clipPath?: string; maskImage?: string; webkitMaskImage?: string; maskSize?: string; webkitMaskSize?: string; filter: string; mixBlendMode?: string } {
  const motion = nleSampleMotion(clip, localMs);
  let opacity = motion.opacity;
  let transform = `translate(${motion.x * 100}%, ${motion.y * 100}%) scale(${motion.scale}) rotate(${motion.rotate}deg)`;
  let clipPath: string | undefined;
  let maskImage: string | undefined, maskSize: string | undefined;
  for (const edge of ["in", "out"] as const) {
    const progress = nleTransitionProgress(clip, localMs, edge);
    if (progress === null) continue;
    const type = (edge === "in" ? clip.transitionIn : clip.transitionOut)!.type;
    const remaining = 1 - progress;
    if (type === "fade") opacity *= progress;
    else if (type === "slide") transform += ` translateX(${(edge === "in" ? -1 : 1) * remaining * 60}%)`;
    else if (type === "zoom") { opacity *= progress; transform += ` scale(${1 + remaining * 0.14})`; }
    else if (type === "wipe") clipPath = edge === "in" ? `inset(0 ${remaining * 100}% 0 0)` : `inset(0 0 0 ${remaining * 100}%)`;
  }
  const mask = clip.mask;
  if (mask) {
    const feather = Math.round((mask.feather ?? 0) * 100);
    if (feather <= 0) {
      clipPath = mask.shape === "circle" ? "circle(50% at 50% 50%)" : `inset(${(mask.inset ?? 0) * 100}%)`;
    } else {
      // Feathered edges use a gradient alpha mask (approximation of a soft mask).
      const solid = mask.invert ? "transparent" : "#000", clear = mask.invert ? "#000" : "transparent";
      if (mask.shape === "circle") maskImage = `radial-gradient(ellipse closest-side at 50% 50%, ${solid} calc(${100 - feather}% - 1px), ${clear} ${100 - feather}%)`;
      else {
        const edge = Math.max(feather, Math.round((mask.inset ?? 0) * 50));
        maskImage = `linear-gradient(90deg, ${clear} 0%, ${solid} ${edge}%, ${solid} ${100 - edge}%, ${clear} 100%)`;
      }
      maskSize = "100% 100%";
    }
  }
  return { opacity, transform, clipPath, maskImage, maskSize, filter: effectFilter(clip, localMs), mixBlendMode: clip.blend && clip.blend !== "normal" ? clip.blend : undefined };
}

function pooled<K extends HTMLVideoElement | HTMLAudioElement | HTMLImageElement | HTMLElement>(host: NleFrameHost, pool: "layers" | "media" | "images", key: string, create: () => K): K {
  host[pool] ??= new Map();
  const existing = host[pool]!.get(key) as K | undefined;
  if (existing) return existing;
  const element = create();
  host[pool]!.set(key, element as never);
  return element;
}

function drawVisualClip(host: NleFrameHost, trackIndex: number, clip: NleClip, localMs: number, active: Set<string>, referenceHeight: number): void {
  active.add(clip.id);
  const layer = pooled(host, "layers", clip.id, () => {
    const element = document.createElement("div");
    element.dataset.clip = clip.id;
    element.style.cssText = "position:absolute;inset:0;width:100%;height:100%;overflow:hidden;";
    host.root.append(element);
    return element;
  });
  layer.style.zIndex = String(trackIndex);
  layer.style.display = "block";
  const style = nleClipStyle(clip, localMs);
  layer.style.opacity = String(style.opacity);
  layer.style.transform = style.transform;
  layer.style.clipPath = style.clipPath ?? "";
  layer.style.filter = style.filter || "none";
  layer.style.mixBlendMode = style.mixBlendMode ?? "normal";
  layer.style.maskImage = style.maskImage ?? "";
  layer.style.maskSize = style.maskSize ?? "";
  (layer.style as CSSStyleDeclaration & { webkitMaskImage?: string }).webkitMaskImage = style.maskImage ?? "";
  (layer.style as CSSStyleDeclaration & { webkitMaskSize?: string }).webkitMaskSize = style.maskSize ?? "";

  if (clip.kind === "text") {
    // Canvas text: Chromium's headless rasteriser drops the CJK fallback when
    // text nodes live inside transformed/filtered layers, so the shared
    // compositor draws glyphs itself. Same output in preview and export.
    const canvas = pooled(host, "images", `text:${clip.id}`, () => {
      const element = document.createElement("canvas");
      element.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;";
      layer.append(element);
      return element as unknown as HTMLImageElement;
    }) as unknown as HTMLCanvasElement;
    const signature = [clip.text, clip.fontSize ?? 64, clip.color ?? "#f4f4f5", clip.weight ?? 700, clip.align ?? "center", referenceHeight].join("|");
    if (canvas.dataset.signature !== signature) {
      canvas.dataset.signature = signature;
      drawTextCanvas(canvas, clip, referenceHeight);
    }
    return;
  }
  if (clip.kind === "image") {
    const image = pooled(host, "images", `img:${clip.id}`, () => {
      const element = document.createElement("img");
      element.alt = "";
      element.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;";
      layer.append(element);
      return element;
    });
    const source = host.resolveAsset(clip.src);
    if (image.getAttribute("src") !== source) image.src = source;
    return;
  }
  // Video: the element lives in the media pool; frame position via target seek.
  const video = pooled(host, "media", `vid:${clip.id}`, () => {
    const element = document.createElement("video");
    element.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;";
    element.preload = "auto";
    element.playsInline = true;
    element.crossOrigin = "anonymous";
    layer.append(element);
    return element;
  });
  const source = host.resolveAsset(clip.src);
  if (video.getAttribute("src") !== source) video.src = source;
  video.volume = clip.volume ?? 1;
  video.playbackRate = clip.speed ?? 1;
  host.targets ??= new Map();
  host.targets.set(`vid:${clip.id}`, (clip.trimStartMs ?? 0) / 1000 + localMs / 1000 * (clip.speed ?? 1));
}

export interface NleFrameOptions {
  /** true: audible media keeps playing from the synced position; false: exact seek (paused/render). */
  playing?: boolean;
  /** Preview mutes everything (e.g. scrubbing) without touching element state. */
  muted?: boolean;
}

/**
 * Draw the complete picture at tMs. Cheap enough for every animation frame:
 * pooled nodes, only changed properties written. Video/audio elements carry
 * their desired source position in `targets`; `playing` decides play vs seek.
 */
export function renderNleFrame(host: NleFrameHost, project: NleProject, tMs: number, options: NleFrameOptions = {}): void {
  host.root.style.width = `${project.width}px`;
  host.root.style.height = `${project.height}px`;
  host.root.style.backgroundColor = project.background ?? "#08090b";
  const active = new Set<string>();
  const audible = host.audible ??= new Set<string>();
  audible.clear();
  project.tracks.forEach((track, trackIndex) => {
    if (track.kind === "audio" || track.muted) return;
    for (const clip of track.clips) {
      const layer = host.layers?.get(clip.id);
      const visible = tMs >= clip.startMs && tMs < clip.startMs + clip.durationMs;
      if (!visible) {
        if (layer) layer.style.display = "none";
        if (clip.kind === "video") {
          const video = host.media?.get(`vid:${clip.id}`);
          if (video && !video.paused) video.pause();
          host.targets?.delete(`vid:${clip.id}`);
        }
        continue;
      }
      drawVisualClip(host, trackIndex, clip, tMs - clip.startMs, active, project.height);
      if (clip.kind === "video" && (clip.volume ?? 1) > 0 && !track.muted) audible.add(`vid:${clip.id}`);
    }
  });
  for (const track of project.tracks) {
    if (track.kind !== "audio" || track.muted) continue;
    const audioClips = track.clips.filter((clip): clip is Extract<NleClip, { kind: "audio" }> => clip.kind === "audio");
    for (const clip of audioClips) {
      const key = `aud:${track.id}:${clip.id}`;
      const audio = pooled(host, "media", key, () => {
        const element = document.createElement("audio");
        element.preload = "auto";
        element.crossOrigin = "anonymous";
        host.root.append(element);
        return element;
      });
      const source = host.resolveAsset(clip.src);
      if (audio.getAttribute("src") !== source) audio.src = source;
      audio.volume = clip.volume ?? 1;
      audio.playbackRate = clip.speed ?? 1;
      host.targets ??= new Map();
      const activeAudio = tMs >= clip.startMs && tMs < clip.startMs + clip.durationMs;
      host.targets.set(key, Math.max(0, (clip.trimStartMs ?? 0) / 1000 + (tMs - clip.startMs) / 1000 * (clip.speed ?? 1)));
      if (!activeAudio) {
        if (!audio.paused) audio.pause();
        continue;
      }
      audible.add(key);
      if (options.playing && !options.muted) {
        if (Math.abs(audio.currentTime - (host.targets.get(key) ?? 0)) > 0.12) audio.currentTime = host.targets.get(key) ?? 0;
        if (audio.paused) void audio.play().catch(() => { /* autoplay can stay blocked until a user gesture */ });
      } else {
        if (!audio.paused) audio.pause();
      }
    }
  }
  for (const [key, element] of host.media ?? []) {
    if (!key.startsWith("vid:")) continue;
    const target = host.targets?.get(key);
    if (target === undefined) continue;
    const playing = options.playing && !options.muted && audible.has(key);
    if (playing) {
      if (Math.abs(element.currentTime - target) > 0.12) element.currentTime = target;
      if (element.paused) void (element as HTMLVideoElement).play().catch(() => { /* gesture-gated */ });
    } else {
      if (!element.paused) (element as HTMLVideoElement).pause();
      if (Math.abs(element.currentTime - target) > 0.02) element.currentTime = target;
    }
  }
  for (const [clipId, layer] of host.layers ?? []) {
    if (!active.has(clipId)) layer.style.display = "none";
  }
}

/**
 * Deterministic seek for the renderer: waits until every pooled media element
 * has arrived at the target written by the last renderNleFrame call.
 */
export function syncNleMedia(host: NleFrameHost, timeoutMs = 8000): Promise<void> {
  const pending: Promise<void>[] = [];
  for (const [key, element] of host.media ?? []) {
    const target = host.targets?.get(key);
    if (target === undefined) continue;
    if (Math.abs(element.currentTime - target) <= 0.004) continue;
    pending.push(new Promise<void>(resolve => {
      const timer = setTimeout(done, timeoutMs);
      function done() {
        clearTimeout(timer);
        element.removeEventListener("seeked", done);
        element.removeEventListener("error", done);
        resolve();
      }
      element.addEventListener("seeked", done, { once: true });
      element.addEventListener("error", done, { once: true });
      element.currentTime = target;
    }));
  }
  return Promise.all(pending).then(() => undefined);
}
