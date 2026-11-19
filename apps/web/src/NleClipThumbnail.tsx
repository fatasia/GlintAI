import { applicationUrl } from "./app-url";
import { useEffect, useRef, useState } from "react";
import { nleSourceTimeMs } from "@glintai/scenescript";
type SpeedClip = Parameters<typeof nleSourceTimeMs>[0];

const MAX_LOADS = 4, MAX_CACHED_FRAMES = 128, MAX_FRAMES_PER_CLIP = 8;
let activeLoads = 0, cachedFrames = 0;
const queue: Array<() => void> = [];
const slotQueue: Array<() => void> = [];
function drain() { while (activeLoads < MAX_LOADS && queue.length) { activeLoads++; queue.shift()!(); } }
function enqueue(start: (release: () => void) => void): () => void {
  let running = false, done = false;
  const run = () => { running = true; start(release); };
  const release = () => { if (done) return; done = true; if (running) activeLoads--; else { const index = queue.indexOf(run); if (index >= 0) queue.splice(index, 1); } drain(); };
  queue.push(run); drain(); return release;
}
function drainSlots() { while (cachedFrames < MAX_CACHED_FRAMES && slotQueue.length) slotQueue.shift()!(); }
function reserveSlots(wanted: number, receive: (count: number) => void): () => void {
  let reserved = 0, done = false;
  const grant = () => { if (done) return; reserved = Math.min(wanted, MAX_CACHED_FRAMES - cachedFrames); cachedFrames += reserved; receive(reserved); };
  slotQueue.push(grant); drainSlots();
  return () => { if (done) return; done = true; const index = slotQueue.indexOf(grant); if (index >= 0) slotQueue.splice(index, 1); cachedFrames -= reserved; drainSlots(); };
}

export function thumbnailTimes(clip: SpeedClip, count: number): number[] {
  return Array.from({ length: count }, (_, index) => nleSourceTimeMs(clip, Math.floor(clip.durationMs * index / count)) / 1000);
}

function ThumbnailImage({ src }: { src: string }) {
  const [ready, setReady] = useState(false), releaseRef = useRef<() => void>(() => {});
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = enqueue(release => { releaseRef.current = () => { if (timer) clearTimeout(timer); release(); }; setReady(true); timer = setTimeout(() => { setReady(false); release(); }, 15000); });
    return () => { if (timer) clearTimeout(timer); cancel(); setReady(false); };
  }, [src]);
  return ready ? <img src={applicationUrl(src)} alt="" draggable={false} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} onLoad={() => releaseRef.current()} onError={() => releaseRef.current()} /> : null;
}

/** One paused decoder per visible clip, sequential seeks; at most 4 decoders and 128 canvases globally. */
function ThumbnailVideo({ src, clip, widthPx }: { src: string; clip: SpeedClip; widthPx: number }) {
  const wanted = Math.max(1, Math.min(MAX_FRAMES_PER_CLIP, Math.ceil(widthPx / 72))), [slots, setSlots] = useState(0);
  const canvases = useRef<Array<HTMLCanvasElement | null>>([]);
  useEffect(() => {
    const release = reserveSlots(wanted, setSlots);
    return () => { setSlots(0); release(); };
  }, [wanted]);
  const { durationMs, trimStartMs, speed, speedCurve } = clip;
  const rampDuration = clip.speedRamp?.durationMs, rampOffset = clip.speedRamp?.offsetMs;
  useEffect(() => {
    if (!slots) return;
    let timer: ReturnType<typeof setTimeout> | undefined, video: HTMLVideoElement | undefined, cancelled = false;
    const reset = () => { if (!video) return; video.onloadedmetadata = null; video.onloadeddata = null; video.onseeked = null; video.onerror = null; try { video.pause(); video.removeAttribute("src"); video.load(); } catch { /* release the queue even if the browser rejects cleanup */ } video = undefined; };
    for (const canvas of canvases.current) { const context = canvas?.getContext("2d"); context?.clearRect(0, 0, 128, 72); canvas?.removeAttribute("data-source-time"); }
    const cancel = enqueue(release => {
      if (cancelled) { release(); return; }
      // Only same-origin local library media is eligible for canvas reads.
      let url: URL; try { url = new URL(applicationUrl(src), location.href); } catch { release(); return; }
      if (url.origin !== location.origin) { release(); return; }
      const clipClock: SpeedClip = { durationMs, trimStartMs, speed, speedCurve, ...(rampDuration !== undefined && rampOffset !== undefined ? { speedRamp: { durationMs: rampDuration, offsetMs: rampOffset } } : {}) };
      const times = thumbnailTimes(clipClock, slots); let index = 0, target = 0;
      video = document.createElement("video"); video.muted = true; video.playsInline = true; video.preload = "auto";
      const finish = () => { if (timer) clearTimeout(timer); reset(); release(); };
      const capture = () => {
        if (cancelled || !video || video.seeking || video.readyState < 2 || Math.abs(video.currentTime - target) > 0.025) return;
        const canvas = canvases.current[index];
        try { const context = canvas?.getContext("2d"); if (!canvas || !context) throw new Error("canvas unavailable"); context.drawImage(video, 0, 0, 128, 72); canvas.setAttribute("data-source-time", String(video.currentTime)); }
        catch { finish(); return; }
        index++; if (index >= times.length) { finish(); return; }
        advance();
      };
      const advance = () => {
        if (!video || !Number.isFinite(video.duration)) { finish(); return; }
        target = Math.min(Math.max(0, times[index]!), Math.max(0, video.duration - 0.05));
        if (!video.seeking && video.readyState >= 2 && Math.abs(video.currentTime - target) <= 0.025) capture();
        else if (Math.abs(video.currentTime - target) > 0.001) { try { video.currentTime = target; } catch { finish(); } }
      };
      video.onloadedmetadata = advance; video.onloadeddata = capture; video.onseeked = capture; video.onerror = finish;
      timer = setTimeout(finish, 15000); try { video.src = url.href; video.load(); } catch { finish(); }
    });
    return () => { cancelled = true; if (timer) clearTimeout(timer); reset(); cancel(); };
  }, [src, slots, durationMs, trimStartMs, speed, speedCurve, rampDuration, rampOffset]);
  return <span style={{ display: "flex", width: "100%", height: "100%" }}>{Array.from({ length: slots }, (_, index) => <canvas key={index} ref={node => { canvases.current[index] = node; }} width={128} height={72} data-nle-thumbnail="" style={{ width: `${100 / slots}%`, height: "100%", objectFit: "cover", minWidth: 0 }} />)}</span>;
}

/** Clip is mounted only while intersecting the timeline viewport. */
export function NleClipThumbnail({ src, kind, trimStartMs = 0, durationMs = 1000, speed, speedCurve, speedRamp, widthPx = 72 }: { src: string; kind: "image" | "video"; trimStartMs?: number; durationMs?: number; speed?: number; speedCurve?: SpeedClip["speedCurve"]; speedRamp?: SpeedClip["speedRamp"]; widthPx?: number }) {
  const root = useRef<HTMLSpanElement>(null), [visible, setVisible] = useState(false);
  useEffect(() => {
    const element = root.current; if (!element) return;
    if (typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)), { rootMargin: "100px" });
    observer.observe(element); return () => observer.disconnect();
  }, []);
  return <span ref={root} aria-hidden="true" style={{ position: "absolute", inset: 0, opacity: 0.65, pointerEvents: "none", overflow: "hidden" }}>
    {visible && (kind === "image" ? <ThumbnailImage src={applicationUrl(src)} /> : <ThumbnailVideo src={applicationUrl(src)} widthPx={widthPx} clip={{ durationMs, trimStartMs, speed, speedCurve, speedRamp }} />)}
  </span>;
}
