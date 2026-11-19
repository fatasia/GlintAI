import { nleSampleMotion, nleTransitionProgress, nleSourceTimeMs, nleSpeedAt, sampleEffects, type NleClip, type NleProject } from "@glintai/scenescript";

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

/** AUDIO-05/07 karaoke: character-ratio progress across the whole clip text.
 * Declared approximation — captions are timed per segment/cue, not acoustically. */
export function karaokeCharStates(text: string, progress: number): Array<{ char: string; sung: boolean; active: boolean }> {
  const chars = [...text];
  const clamped = Math.max(0, Math.min(1, progress));
  const sungCount = Math.round(chars.length * clamped);
  return chars.map((char, index) => ({ char, sung: index < sungCount, active: index === sungCount }));
}

function drawTextCanvas(canvas: HTMLCanvasElement, clip: Extract<NleClip, { kind: "text" }>, referenceHeight: number, localMs: number): void {
  // clientWidth ignores CSS transforms, so the backing store stays at project
  // resolution even when the preview root is scaled down to fit its panel.
  const targetWidth = Math.max(16, Math.round(canvas.clientWidth || canvas.parentElement?.clientWidth || 1920));
  const targetHeight = Math.max(16, Math.round(canvas.clientHeight || canvas.parentElement?.clientHeight || 1080));
  if (canvas.width !== targetWidth || canvas.height !== targetHeight) { canvas.width = targetWidth; canvas.height = targetHeight; }
  const context = canvas.getContext("2d");
  if (!context) return;
  const size = (clip.fontSize ?? 64) * (targetHeight / referenceHeight);
  const weight = clip.weight ?? 700;
  context.clearRect(0, 0, targetWidth, targetHeight);
  context.font = `${weight} ${size}px ${FONT_STACK}`;
  context.textBaseline = "middle";
  const padding = targetWidth * 0.08;
  const lines = wrapLines(context, clip.text, targetWidth - padding * 2);
  const lineHeight = size * 1.35;
  const startY = targetHeight / 2 - (lines.length - 1) * lineHeight / 2;
  const karaoke = clip.karaoke === true;
  const baseColor = clip.color ?? "#f4f4f5";
  if (!karaoke) context.fillStyle = baseColor;
  // Character-ratio progress across the WHOLE text; sung chars keep the base
  // color, the active char is amber, upcoming chars are dimmed.
  const states = karaoke ? karaokeCharStates(clip.text, clip.durationMs ? localMs / clip.durationMs : 1) : null;
  let charCursor = 0;
  lines.forEach((line, index) => {
    const y = startY + index * lineHeight;
    const startX = clip.align === "left" ? padding : clip.align === "right" ? targetWidth - padding : targetWidth / 2;
    if (!states) {
      if (clip.align === "left") { context.textAlign = "left"; context.fillText(line, padding, y); }
      else if (clip.align === "right") { context.textAlign = "right"; context.fillText(line, targetWidth - padding, y); }
      else { context.textAlign = "center"; context.fillText(line, targetWidth / 2, y); }
      return;
    }
    context.textAlign = "left";
    const slice = [...line];
    const lineChars = states.slice(charCursor, charCursor + slice.length);
    charCursor += slice.length;
    let x = clip.align === "right" ? targetWidth - padding - context.measureText(line).width : clip.align === "center" ? targetWidth / 2 - context.measureText(line).width / 2 : startX;
    for (const state of lineChars) {
      context.globalAlpha = state.sung ? 1 : 0.4;
      context.fillStyle = state.active ? "#fbbf24" : baseColor;
      context.fillText(state.char, x, y);
      x += context.measureText(state.char).width;
    }
    context.globalAlpha = 1;
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
    const signature = [clip.text, clip.fontSize ?? 64, clip.color ?? "#f4f4f5", clip.weight ?? 700, clip.align ?? "center", referenceHeight, clip.karaoke === true ? Math.round(localMs) : ""].join("|");
    if (canvas.dataset.signature !== signature) {
      canvas.dataset.signature = signature;
      drawTextCanvas(canvas, clip, referenceHeight, localMs);
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
  video.playbackRate = nleSpeedAt(clip, localMs);
  video.preservesPitch = !clip.speedCurve || clip.speedCurve === "linear";
  host.targets ??= new Map();
  host.targets.set(`vid:${clip.id}`, nleSourceTimeMs(clip, localMs) / 1000);
}

export interface NleFrameOptions {
  /** true: audible media keeps playing from the synced position; false: exact seek (paused/render). */
  playing?: boolean;
  /** Preview mutes everything (e.g. scrubbing) without touching element state. */
  muted?: boolean;
  /** Export only: omit the project background for alpha overlays. */
  transparentBackground?: boolean;
}

/**
 * Draw the complete picture at tMs. Cheap enough for every animation frame:
 * pooled nodes, only changed properties written. Video/audio elements carry
 * their desired source position in `targets`; `playing` decides play vs seek.
 */
export function renderNleFrame(host: NleFrameHost, project: NleProject, tMs: number, options: NleFrameOptions = {}): void {
  host.root.style.width = `${project.width}px`;
  host.root.style.height = `${project.height}px`;
  host.root.style.backgroundColor = options.transparentBackground ? "transparent" : project.background ?? "#08090b";
  const active = new Set<string>();
  const audible = host.audible ??= new Set<string>();
  audible.clear();
  // Solo audition must match the ffmpeg mixer (nle-render): when any track is
  // solo, non-solo tracks stay silent in the preview too.
  const soloActive = project.tracks.some(track => track.solo);
  const audibleTrack = (track: NleProject["tracks"][number]) => !track.muted && (!soloActive || track.solo === true);
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
      if (clip.kind === "video" && (clip.volume ?? 1) > 0 && audibleTrack(track)) audible.add(`vid:${clip.id}`);
    }
  });
  for (const track of project.tracks) {
    if (track.kind !== "audio" || !audibleTrack(track)) continue;
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
      audio.playbackRate = nleSpeedAt(clip, tMs - clip.startMs);
      audio.preservesPitch = !clip.speedCurve || clip.speedCurve === "linear";
      host.targets ??= new Map();
      const activeAudio = tMs >= clip.startMs && tMs < clip.startMs + clip.durationMs;
      host.targets.set(key, Math.max(0, nleSourceTimeMs(clip, tMs - clip.startMs) / 1000));
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
    if (key.startsWith("aud:")) {
      if (!options.playing || options.muted || !audible.has(key)) element.pause();
      continue;
    }
    if (!key.startsWith("vid:")) continue;
    const target = host.targets?.get(key);
    element.muted = Boolean(options.muted || !audible.has(key));
    if (target === undefined) { element.pause(); continue; }
    const playing = options.playing && active.has(key.slice("vid:".length));
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
 * has arrived at the target written by the last renderNleFrame call — and,
 * for video, until the sought frame is actually presented. "seeked" alone can
 * resolve while the compositor still shows the previous frame (scrub race).
 */
export function syncNleMedia(host: NleFrameHost, timeoutMs = 8000): Promise<void> {
  const pending: Promise<void>[] = [];
  for (const [key, element] of host.media ?? []) {
    const target = host.targets?.get(key);
    if (target === undefined) continue;
    if (Math.abs(element.currentTime - target) <= 0.004) continue;
    const destination = target;
    let nudgeTimer: ReturnType<typeof setTimeout> | undefined;
    pending.push(new Promise<void>(resolve => {
      const timer = setTimeout(done, timeoutMs);
      function done() {
        clearTimeout(timer);
        if (nudgeTimer !== undefined) clearTimeout(nudgeTimer);
        element.removeEventListener("seeked", presented);
        element.removeEventListener("error", done);
        resolve();
      }
      function presented() {
        const video = element as HTMLVideoElement;
        if (typeof video.requestVideoFrameCallback !== "function") return done();
        // A frame queued before the seek can present first; only a frame whose
        // mediaTime reached the target proves the sought content is on screen.
        // Chromium occasionally stalls the present after a paused seek: nudge
        // the same frame (+0.5ms stays inside it) to force a fresh present.
        nudgeTimer = setTimeout(() => { video.currentTime = destination + 0.0005; }, 1200);
        const deadline = Date.now() + 5000;
        const awaitFrame = () => {
          video.requestVideoFrameCallback((_now, metadata) => {
            if (metadata.mediaTime >= destination - 0.045) return done();
            if (Date.now() > deadline) return done();
            awaitFrame();
          });
        };
        awaitFrame();
      }
      element.addEventListener("seeked", presented, { once: true });
      element.addEventListener("error", done, { once: true });
      element.currentTime = target;
    }));
  }
  return Promise.all(pending).then(() => undefined);
}
