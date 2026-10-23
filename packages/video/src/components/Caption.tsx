import {
  estimateWordTimings,
  type Scene,
  type WordTiming,
} from "@glintai/scenescript";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { useMemo } from "react";

// Han/kana/hangul plus CJK punctuation and fullwidth forms — these flow
// without extra spacing, unlike latin words.
const CJK =
  /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af\uff00-\uffef]/;

const wordStyle = (spoken: boolean, active: boolean): React.CSSProperties => ({
  color: active
    ? "var(--glint-color-accent)"
    : spoken
      ? "var(--glint-color-text)"
      : "var(--glint-color-text-muted)",
  transition: "none",
});
export function captionPage(words: WordTiming[], nowMs: number, capacity: number): WordTiming[] {
  const pages: WordTiming[][] = [];
  let start = 0;
  while (start < words.length) {
    let end = start, weight = 0, lastBreak = -1;
    while (end < words.length) {
      const word = words[end]!;
      const size = CJK.test(word.text) ? word.text.length : word.text.length * 0.6 + 0.3;
      if (end > start && weight + size > capacity) break;
      weight += size;
      if (/[。！？.!?，,；;：:]$/.test(word.text) && weight >= capacity * 0.5) lastBreak = end + 1;
      end++;
    }
    if (end < words.length && lastBreak > start) end = lastBreak;
    pages.push(words.slice(start, end)); start = end;
  }
  return pages.find((part) => part[part.length - 1]!.endMs > nowMs) ?? pages[pages.length - 1] ?? [];
}

/**
 * Karaoke caption: highlights the word currently being spoken, using
 * provider word timings when available and text-weight estimates otherwise.
 */
export const Caption: React.FC<{
  scene: Scene;
  sceneDurationFrames: number;
}> = ({ scene, sceneDurationFrames }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const side = width / height < 1.3 ? 76 : 170;
  const { narration } = scene;
  const durationMs = Math.max(1, (sceneDurationFrames / fps) * 1000);

  const words = useMemo<WordTiming[]>(() => {
    const fromSegments = narration.segments?.flatMap(
      (segment) => segment.words ?? [],
    );
    if (fromSegments && fromSegments.length > 0) return fromSegments;
    return estimateWordTimings(narration.text, durationMs);
  }, [narration, durationMs]);

  // Burned captions stay scene-local, but follow the same rounded offset as narration audio.
  const offsetMs = narration.audioOffsetMs ?? 0;
  const captionFrame = frame - Math.round((Number.isFinite(offsetMs) ? offsetMs : 0) / 1000 * fps);
  if (captionFrame < 0) return null;
  const nowMs = (captionFrame / fps) * 1000;
  const visible = captionPage(words, nowMs, Math.floor((width - side * 2) / 24));

  return (
    <div
      style={{
        position: "absolute",
        left: side,
        right: side,
        bottom: 130,
        display: "flex",
        flexWrap: "wrap",
        rowGap: 8,
        fontSize: "var(--glint-font-size-caption)",
        lineHeight: 1.55,
        // CJK punctuation must never start a line (禁则处理).
        lineBreak: "strict",
      }}
    >
      {visible.map((word, index) => {
        const isCjkGlyph = CJK.test(word.text) && word.text.length === 1;
        const next = visible[index + 1];
        const nextIsLatinPunct =
          next !== undefined && !CJK.test(next.text) && /^[\p{P}\p{S}]+$/u.test(next.text);
        // Latin words need visual separation; CJK glyphs flow naturally;
        // a word hugs trailing punctuation instead of floating away from it.
        const marginRight = isCjkGlyph || nextIsLatinPunct ? 0 : "0.3em";
        return (
          <span
            key={`${index}-${word.text}`}
            style={{
              ...wordStyle(nowMs >= word.endMs, nowMs >= word.startMs && nowMs < word.endMs),
              marginRight,
              overflowWrap: "anywhere",
              minWidth: 0,
            }}
          >
            {word.text}
          </span>
        );
      })}
    </div>
  );
};
