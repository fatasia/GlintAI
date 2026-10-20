import { useEffect, useRef, useState, type CSSProperties } from "react";
import { downloadJson } from "./editor-model";

type Clip = { name: string; url: string };
const criteria = ["声音相似度", "发音准确度", "自然度", "节奏与停顿"];
const control = { color: "#d7e7fb", background: "#1b2838", border: "1px solid #445870", padding: 10, borderRadius: 8, font: "inherit" };

/** Files stay in the browser; randomized A/B labels are revealed only after rating. */
export function VoiceReview({ cardStyle }: { cardStyle: CSSProperties }) {
  const [reference, setReference] = useState<Clip | null>(null);
  const [samples, setSamples] = useState<Clip[]>([]);
  const [scores, setScores] = useState<number[][]>([]);
  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState("");
  const urls = useRef<string[]>([]);
  const referenceUrl = useRef<string | null>(null);
  useEffect(() => () => { urls.current.forEach(URL.revokeObjectURL); if (referenceUrl.current) URL.revokeObjectURL(referenceUrl.current); }, []);
  const choose = (files: FileList | null, isReference: boolean) => {
    if (!files?.length) return;
    const selected = Array.from(files);
    if (selected.length > (isReference ? 1 : 2) || selected.some(file => !file.type.startsWith("audio/") || file.size > 32 * 1024 * 1024)) { setError("选择音频文件，每个不超过 32 MB；对比最多两段。"); return; }
    setError(""); setRevealed(false);
    if (isReference) {
      if (referenceUrl.current) URL.revokeObjectURL(referenceUrl.current);
      const url = URL.createObjectURL(selected[0]!); referenceUrl.current = url;
      setReference({ name: selected[0]!.name, url });
      setScores(rows => rows.map(() => [0, 0, 0, 0]));
    } else {
      urls.current.forEach(URL.revokeObjectURL);
      if (selected.length === 2 && crypto.getRandomValues(new Uint8Array(1))[0]! % 2) selected.reverse();
      const clips = selected.map(file => ({ name: file.name, url: URL.createObjectURL(file) }));
      urls.current = clips.map(item => item.url); setSamples(clips); setScores(clips.map(() => [0, 0, 0, 0]));
    }
  };
  const complete = Boolean(reference && samples.length && scores.every(row => row.every(score => score >= 1 && score <= 5)));
  return <section style={{ ...cardStyle, padding: 26, display: "grid", gap: 16 }}>
    <h2 style={{ margin: 0, fontSize: 22 }}>配音听评</h2>
    <p style={{ margin: 0, color: "#a7b4c4" }}>载入参考录音与候选配音，逐项听评。文件仅在浏览器中播放，不上传。A/B 顺序随机，评分后揭晓文件名。</p>
    <details><summary>开始听评</summary>
      <div style={{ display: "grid", gap: 16, marginTop: 16 }}>
        <label>参考录音<input style={{ display: "block", maxWidth: "100%" }} aria-label="参考录音" type="file" accept="audio/*" onChange={event => choose(event.target.files, true)} /></label>
        {reference && <audio aria-label="参考录音播放" src={reference.url} controls preload="metadata" style={{ width: "100%" }} />}
        <label>候选配音（1–2 段）<input style={{ display: "block", maxWidth: "100%" }} aria-label="候选配音" type="file" accept="audio/*" multiple onChange={event => choose(event.target.files, false)} /></label>
        {samples.map((sample, index) => <div key={sample.url} style={{ border: "1px solid #304053", padding: 14, borderRadius: 10, display: "grid", gap: 12 }}>
          <strong>候选 {String.fromCharCode(65 + index)}{revealed ? ` · ${sample.name}` : ""}</strong>
          <audio aria-label={`候选 ${index + 1} 播放`} src={sample.url} controls preload="metadata" style={{ width: "100%" }} />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,160px),1fr))", gap: 8 }}>
            {criteria.map((label, column) => <label key={label}>{label}<select aria-label={`候选 ${index + 1} ${label}`} style={{ ...control, width: "100%" }} value={scores[index]?.[column] ?? 0} onChange={event => { setRevealed(false); setScores(rows => rows.map((row, i) => i === index ? row.map((score, j) => j === column ? Number(event.target.value) : score) : row)); }}><option value={0}>未评分</option>{[1, 2, 3, 4, 5].map(value => <option key={value}>{value}</option>)}</select></label>)}
          </div>
        </div>)}
        <small style={{ color: "#a7b4c4" }}>1 严重问题 · 2 明显不足 · 3 可用但需修改 · 4 良好 · 5 优秀。相似度请对照参考听，不按文件名或模型名猜测。</small>
        <button style={control} disabled={!complete} onClick={() => setRevealed(true)}>评分完成，揭晓文件名</button>
        <button style={control} disabled={!complete || !revealed} onClick={() => downloadJson("glint-voice-listening-review.json", { version: 1, createdAt: new Date().toISOString(), method: "local-human-rating-randomized-labels", reference: reference?.name, criteria, samples: samples.map((sample, i) => ({ label: String.fromCharCode(65 + i), file: sample.name, scores: scores[i] })), scope: "One listener self-reported scores; not independent identity verification or a population study" })}>导出听评记录</button>
        {error && <p role="alert">{error}</p>}
      </div>
    </details>
  </section>;
}
