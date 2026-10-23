import { useEffect, useRef, useState } from "react";

/** Peak envelope for a canvas waveform; exported so it can be tested without Web Audio. */
export function waveformPeaks(samples: Float32Array, bars = 96): number[] {
  if (!samples.length) return Array.from({ length: bars }, () => 0);
  const peaks = Array.from({ length: bars }, (_, index) => {
    const from = Math.floor((index / bars) * samples.length), to = Math.max(from + 1, Math.floor(((index + 1) / bars) * samples.length));
    let peak = 0;
    for (let i = from; i < Math.min(to, samples.length); i++) peak = Math.max(peak, Math.abs(samples[i] ?? 0));
    return peak;
  });
  const loudest = Math.max(...peaks, 0.0001);
  return peaks.map(peak => peak / loudest);
}

/**
 * Draws the actual narration preview after it is generated. No audio is
 * uploaded: the blob URL is decoded in this browser and discarded on change.
 */
export function VoiceWaveform({ src }: { src: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "unsupported">("loading");
  useEffect(() => {
    let cancelled = false;
    const AudioContextClass = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) { setState("unsupported"); return () => { cancelled = true; }; }
    const context = new AudioContextClass();
    void fetch(src)
      .then(response => response.arrayBuffer())
      .then(buffer => context.decodeAudioData(buffer))
      .then(audio => {
        if (cancelled) return;
        const target = canvas.current;
        if (!target) return;
        const bars = waveformPeaks(audio.getChannelData(0));
        const ratio = window.devicePixelRatio || 1, width = target.clientWidth || 280, height = 36;
        target.width = Math.round(width * ratio); target.height = Math.round(height * ratio);
        const ctx = target.getContext("2d");
        if (!ctx) { setState("unsupported"); return; }
        ctx.scale(ratio, ratio); ctx.clearRect(0, 0, width, height);
        const slot = width / bars.length;
        ctx.fillStyle = "#7c8cff";
        bars.forEach((peak, index) => {
          const barHeight = Math.max(1, peak * (height - 6));
          ctx.fillRect(index * slot + 0.5, (height - barHeight) / 2, Math.max(1, slot - 1.2), barHeight);
        });
        setState("ready");
      })
      .catch(() => { if (!cancelled) setState("unsupported"); })
      .finally(() => { void context.close(); });
    return () => { cancelled = true; };
  }, [src]);
  if (state === "unsupported") return <small style={{ color: "#8b8b95" }}>当前浏览器无法解码波形；试听仍可用。</small>;
  return <canvas ref={canvas} role="img" aria-label="配音波形" style={{ width: "100%", height: 36, display: "block", borderRadius: 6, background: "#101013", border: "1px solid #26262b", opacity: state === "loading" ? 0.5 : 1 }} />;
}
