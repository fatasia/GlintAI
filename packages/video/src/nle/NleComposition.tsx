import { AbsoluteFill, Audio, Img, OffthreadVideo, Sequence, useCurrentFrame, useVideoConfig } from "remotion";
import { nleTransitionProgress, sampleEffects, type NleClip, type NleProject, type NleTransform } from "@glintai/scenescript";
import { MediaAssetProvider, useMediaAssetSrc, type MediaAssetBase } from "../components/MediaAssetContext";

function clipTransform(transform: NleTransform | undefined, opacity: number | undefined): React.CSSProperties {
  const x = (transform?.x ?? 0) * 100, y = (transform?.y ?? 0) * 100;
  return {
    opacity: opacity ?? 1,
    transform: `translate(${x}%, ${y}%) scale(${transform?.scale ?? 1}) rotate(${transform?.rotate ?? 0}deg)`,
  };
}

/**
 * Edge transitions render inside the clip window, so a cut needs no overlap on
 * the timeline and the preview equals the export without extra bookkeeping.
 */
function edgeTransition(clip: NleClip, localMs: number): { opacity: number; transform: string; clipPath?: string } {
  let opacity = 1, transform = "", clipPath: string | undefined;
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
  return { opacity, transform, clipPath };
}

function cssFilter(clip: NleClip, localMs: number): string {
  const effects = sampleEffects(clip.effects ?? [], localMs);
  return effects.map(effect => ({
    brightness: `brightness(${effect.value})`, contrast: `contrast(${effect.value})`,
    saturate: `saturate(${effect.value})`, grayscale: `grayscale(${effect.value})`,
    sepia: `sepia(${effect.value})`, hue: `hue-rotate(${effect.value}deg)`, blur: `blur(${effect.value}px)`,
  })[effect.kind]).filter(Boolean).join(" ");
}

function VisualClip({ clip, width, height }: { clip: NleClip; width: number; height: number }) {
  const frame = useCurrentFrame(), { fps } = useVideoConfig();
  const localMs = frame / fps * 1000;
  const base = clipTransform(clip.transform, clip.opacity), edge = edgeTransition(clip, localMs);
  const style: React.CSSProperties = {
    position: "absolute", inset: 0, width: "100%", height: "100%",
    opacity: (clip.opacity ?? 1) * edge.opacity,
    transform: `${edge.transform} ${base.transform ?? ""}`.trim(),
    clipPath: edge.clipPath,
    filter: cssFilter(clip, localMs) || undefined,
  };
  if (clip.kind === "text") {
    const size = (clip.fontSize ?? 64) * (height / 1080);
    return <div style={{ ...style, display: "flex", alignItems: "center", justifyContent: clip.align === "left" ? "flex-start" : clip.align === "right" ? "flex-end" : "center", padding: width * 0.08 }}>
      <span style={{ maxWidth: "100%", color: clip.color ?? "#f4f4f5", fontSize: size, fontWeight: clip.weight ?? 700, lineHeight: 1.35, textAlign: clip.align ?? "center", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{clip.text}</span>
    </div>;
  }
  if (clip.kind === "image") {
    const src = useMediaAssetSrc(clip.src);
    return <Img src={src} style={{ ...style, objectFit: "cover" }} />;
  }
  if (clip.kind === "video") {
    const src = useMediaAssetSrc(clip.src);
    const speed = clip.speed ?? 1;
    const trim = Math.round((clip.trimStartMs ?? 0) / 1000 * fps);
    return <OffthreadVideo src={src} startFrom={trim} endAt={trim + Math.round(clip.durationMs / 1000 * speed * fps)} playbackRate={speed} volume={clip.volume ?? 1} style={{ ...style, objectFit: "cover" }} />;
  }
  return null;
}

/**
 * Multi-track composite shared by Studio preview and the Remotion render.
 * Track order is bottom-first: the first track is the background, later tracks paint above it.
 */
function AudioClip({ clip }: { clip: Extract<NleClip, { kind: "audio" }> }) {
  const { fps } = useVideoConfig();
  const src = useMediaAssetSrc(clip.src);
  const trim = Math.round((clip.trimStartMs ?? 0) / 1000 * fps), speed = clip.speed ?? 1;
  return <Audio src={src} startFrom={trim} endAt={trim + Math.round(clip.durationMs / 1000 * speed * fps)} playbackRate={speed} volume={clip.volume ?? 1} />;
}

function NleInner({ project }: { project: NleProject }) {
  const { fps, width, height } = useVideoConfig();
  const visual = project.tracks.filter(track => track.kind !== "audio" && !track.muted);
  const audio = project.tracks.filter(track => track.kind === "audio" && !track.muted);
  return <AbsoluteFill style={{ backgroundColor: project.background ?? "#08090b" }}>
    {visual.map((track, trackIndex) => <AbsoluteFill key={track.id} style={{ zIndex: trackIndex }}>
      {track.clips.map(clip => {
        const from = Math.round(clip.startMs / 1000 * fps), frames = Math.max(1, Math.round(clip.durationMs / 1000 * fps));
        return <Sequence key={clip.id} from={from} durationInFrames={frames}><VisualClip clip={clip} width={width} height={height} /></Sequence>;
      })}
    </AbsoluteFill>)}
    {audio.flatMap(track => track.clips.map(clip => {
      if (clip.kind !== "audio") return null;
      const from = Math.round(clip.startMs / 1000 * fps), frames = Math.max(1, Math.round(clip.durationMs / 1000 * fps));
      return <Sequence key={`${track.id}-${clip.id}`} from={from} durationInFrames={frames}><AudioClip clip={clip} /></Sequence>;
    }))}
  </AbsoluteFill>;
}

export function NleComposition({ project, mediaAssetBase }: { project: NleProject; mediaAssetBase?: MediaAssetBase }) {
  return <MediaAssetProvider mediaAssetBase={mediaAssetBase}><NleInner project={project} /></MediaAssetProvider>;
}
