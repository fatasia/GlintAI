import { applicationUrl } from "./app-url";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { calibrationToManualGrid, type ManualBeatGrid } from "./nle-beat-grid";

export interface BeatCandidate { bpm: number; offsetMs: number; alignment: number; matchedPeaks: number; medianErrorMs: number | null }
export interface BeatCalibration { status: "candidates" | "ambiguous" | "insufficient"; reason: string; candidates: BeatCandidate[] }

/** Treat calibration as untrusted optional response data; never infer confidence from alignment. */
export function parseBeatCalibration(value: unknown, durationMs: number): BeatCalibration | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  if (!["candidates", "ambiguous", "insufficient"].includes(String(data.status)) || typeof data.reason !== "string" || data.reason.length > 500 || !Array.isArray(data.candidates) || data.candidates.length > 5) return null;
  const candidates: BeatCandidate[] = [];
  for (const item of data.candidates) {
    if (!item || typeof item !== "object") return null;
    const c = item as BeatCandidate;
    if (!calibrationToManualGrid(c, 0) || c.offsetMs >= durationMs || !Number.isFinite(c.alignment) || c.alignment < 0 || c.alignment > 1 || !Number.isSafeInteger(c.matchedPeaks) || c.matchedPeaks < 0 || c.matchedPeaks > 1000 || (c.medianErrorMs !== null && (!Number.isFinite(c.medianErrorMs) || c.medianErrorMs < 0))) return null;
    candidates.push(c);
  }
  if ((data.status === "insufficient") !== (candidates.length === 0)) return null;
  return { status: data.status as BeatCalibration["status"], reason: data.reason, candidates };
}

/** Preview the source segment with a metronome; it never changes the timeline or grid. */
export function NleBeatCalibration({ calibration, clip, onApply, button }: {
  calibration: BeatCalibration | null; clip: { src: string; startMs: number; trimStartMs: number; durationMs: number; signature: string } | null;
  onApply(grid: ManualBeatGrid): void; button: CSSProperties;
}) {
  const [selected, setSelected] = useState<number | null>(null), [playing, setPlaying] = useState(false), [feedback, setFeedback] = useState("");
  const stopRef = useRef<(() => void) | null>(null);
  useEffect(() => { setSelected(null); setFeedback(""); stopRef.current?.(); stopRef.current = null; setPlaying(false); }, [calibration, clip?.signature]);
  useEffect(() => () => stopRef.current?.(), []);
  const stop = () => { stopRef.current?.(); stopRef.current = null; setPlaying(false); };
  const audition = async () => {
    if (!clip || selected === null || !calibration) return;
    stop(); setFeedback("正在准备试听…");
    const candidate = calibration.candidates[selected]; if (!candidate) return;
    let context: AudioContext;
    try { context = new AudioContext(); } catch { setFeedback("此浏览器不支持节拍试听，请手动校准。"); return; }
    const audio = new Audio(applicationUrl(`/api/media/assets/${encodeURIComponent(clip.src.slice("assets/".length))}`));
    let timer: ReturnType<typeof setInterval> | undefined, stopped = false, nextBeat = 0;
    const cleanup = () => { if (stopped) return; stopped = true; if (timer) clearInterval(timer); audio.onerror = null; audio.onended = null; audio.pause(); audio.removeAttribute("src"); audio.load(); void context.close(); };
    stopRef.current = cleanup; setPlaying(true);
    audio.onerror = () => { if (stopRef.current === cleanup) { stop(); setFeedback("音频试听失败，请检查素材后重试。"); } };
    audio.onended = () => { if (stopRef.current === cleanup) { stop(); setFeedback("试听结束。"); } };
    try {
      await context.resume();
      if (stopped) return;
      audio.currentTime = clip.trimStartMs / 1000;
      await audio.play();
      if (stopped) return;
      setPlaying(true); setFeedback("正在试听源音频与候选节拍；再次点击可停止。");
      const period = 60_000 / candidate.bpm;
      timer = setInterval(() => {
        const elapsed = audio.currentTime * 1000 - clip.trimStartMs;
        if (audio.ended || elapsed >= clip.durationMs) { stop(); setFeedback("试听结束。"); return; }
        while (candidate.offsetMs + nextBeat * period < elapsed - 80) nextBeat++;
        if (candidate.offsetMs + nextBeat * period <= elapsed + 30) {
          const oscillator = context.createOscillator(), gain = context.createGain();
          const when = context.currentTime + Math.max(0, (candidate.offsetMs + nextBeat * period - elapsed) / 1000);
          oscillator.frequency.value = 1000; gain.gain.setValueAtTime(0.15, when); gain.gain.exponentialRampToValueAtTime(0.001, when + 0.045);
          oscillator.connect(gain); gain.connect(context.destination); oscillator.start(when); oscillator.stop(when + 0.05); nextBeat++;
        }
      }, 25);
    } catch { cleanup(); if (stopRef.current === cleanup) { stopRef.current = null; setPlaying(false); setFeedback("试听失败，请检查素材或浏览器音频权限后重试。"); } }
  };
  if (!calibration || !clip) return null;
  const chosen = selected === null ? null : calibration.candidates[selected];
  const grid = chosen ? calibrationToManualGrid(chosen, clip.startMs) : null;
  return <section aria-label="节拍校准候选" style={{ display: "grid", gap: 6, paddingTop: 8 }}>
    <strong>固定节拍候选</strong>
    <small>{calibration.reason} 倍速、半速或弱匹配可能误导；一致性指标不是准确概率。试听为源音频与节拍声，不含混音效果。</small>
    <small>固定网格会延伸到整个时间轴，但候选只基于当前片段；长片、变速或复杂音乐可能逐渐偏离。请在后段复核并手动调整 BPM 和偏移，必要时分段校准。</small>
    {calibration.candidates.length > 0 && <fieldset style={{ border: "1px solid var(--line-2)", borderRadius: 8, display: "grid", gap: 4 }}><legend>选择候选</legend>
      {calibration.candidates.map((candidate, index) => <label key={index}><input type="radio" name="beat-calibration" checked={selected === index} onChange={() => { stop(); setSelected(index); setFeedback(""); }} /> {candidate.bpm} BPM · 片段内偏移 {candidate.offsetMs} ms · 匹配峰值 {candidate.matchedPeaks} · 相位一致性 {candidate.alignment.toFixed(3)}</label>)}
    </fieldset>}
    {calibration.candidates.length > 0 && <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      <button type="button" style={button} disabled={selected === null} onClick={() => playing ? stop() : void audition()}>{playing ? "停止试听" : "试听所选候选"}</button>
      <button type="button" style={button} disabled={!grid} onClick={() => { if (grid) { stop(); onApply(grid); setFeedback("已应用到手动网格，并开启吸附与节拍吸附；可继续编辑或关闭。"); } }}>应用所选到手动网格</button>
    </div>}
    {chosen && !grid && <small role="alert">候选超出时间轴范围，不能应用。</small>}
    {feedback && <small role="status">{feedback}</small>}
  </section>;
}
