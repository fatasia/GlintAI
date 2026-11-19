/** Estimate periodic grids from detected energy peaks, not musical ground truth. */
const MIN_BPM = 60, MAX_BPM = 200, STEP_BPM = 0.2;
const MAX_PEAKS = 1000, MIN_PEAKS = 6, MIN_SPAN_MS = 3000;

function measure(peaks, bpm) {
  const period = 60_000 / bpm;
  let x = 0, y = 0;
  for (const time of peaks) {
    const angle = 2 * Math.PI * time / period;
    x += Math.cos(angle); y += Math.sin(angle);
  }
  const phase = ((Math.atan2(y, x) / (2 * Math.PI) * period) % period + period) % period;
  const errors = peaks.map(time => {
    const distance = Math.abs(((time - phase + period / 2) % period + period) % period - period / 2);
    return distance;
  });
  const matched = errors.filter(error => error <= Math.min(60, period * 0.12));
  return { bpm, offsetMs: Math.round(phase * 10) / 10, alignment: Math.round(Math.hypot(x, y) / peaks.length * 1000) / 1000,
    matchedPeaks: matched.length, medianErrorMs: matched.length ? Math.round(matched.sort((a, b) => a - b)[Math.floor(matched.length / 2)] * 10) / 10 : null };
}

/** Input times are relative to the decoded segment. Returns alternatives, never an asserted beat track. */
export function estimateBeatGrids(peaksMs, durationMs) {
  if (!Array.isArray(peaksMs) || !Number.isFinite(durationMs) || durationMs < 500 || durationMs > 120_000 || peaksMs.length > MAX_PEAKS || peaksMs.some((time, i) => !Number.isFinite(time) || time < 0 || time >= durationMs || (i > 0 && time <= peaksMs[i - 1]))) {
    throw new TypeError("无效的音频峰值数据。");
  }
  if (peaksMs.length < MIN_PEAKS || peaksMs.at(-1) - peaksMs[0] < MIN_SPAN_MS) {
    return { status: "insufficient", candidates: [], reason: "峰值不足或分布范围过短，无法可靠估计固定节奏。" };
  }
  const options = [];
  for (let step = 0; step <= Math.round((MAX_BPM - MIN_BPM) / STEP_BPM); step++) {
    const bpm = Math.round((MIN_BPM + step * STEP_BPM) * 10) / 10;
    options.push(measure(peaksMs, bpm));
  }
  options.sort((a, b) => b.alignment - a.alignment || b.matchedPeaks - a.matchedPeaks || a.bpm - b.bpm);
  const candidates = [options[0]];
  // Preserve tempo-halving/doubling alternatives before nearby numerical variations
  // occupy the limited list. They remain hypotheses, not verified musical beats.
  for (const target of [options[0].bpm / 2, options[0].bpm * 2]) {
    if (target < MIN_BPM || target > MAX_BPM) continue;
    const harmonic = options.find(option => Math.abs(option.bpm - target) <= STEP_BPM);
    if (harmonic && candidates.every(item => Math.abs(item.bpm - harmonic.bpm) >= 3)) candidates.push(harmonic);
  }
  for (const candidate of options) {
    if (candidates.every(item => Math.abs(item.bpm - candidate.bpm) >= 3)) candidates.push(candidate);
    if (candidates.length === 5) break;
  }
  candidates.sort((a, b) => b.alignment - a.alignment || b.matchedPeaks - a.matchedPeaks || a.bpm - b.bpm);
  const best = candidates[0];
  const weak = best.alignment < 0.75 || best.matchedPeaks / peaksMs.length < 0.7;
  return { status: weak ? "ambiguous" : "candidates", candidates, reason: weak
    ? "峰值与固定网格吻合较弱；请手动校准或选择其他片段。"
    : "候选按峰值相位一致性排序；倍速、半速和切分节奏可能产生歧义，需试听校准。" };
}
