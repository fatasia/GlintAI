import { estimateNarrationDurationMs, type ChartScene } from "@glintai/scenescript";
import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { Heading } from "../components/Heading";

export function chartDomain(data: { value: number }[]) {
  const min = Math.min(0, ...data.map(item => item.value)), max = Math.max(0, ...data.map(item => item.value));
  return { min, max: min === max ? max + 1 : max };
}
/** Data stays editable; all animation is frame-derived and deterministic in MP4/export. */
export function ChartSceneView({ scene }: { scene: ChartScene }) {
  const frame = useCurrentFrame(), { fps, width, height } = useVideoConfig();
  const pages = Math.ceil(scene.data.length / 6), duration = scene.narration.durationMs ?? estimateNarrationDurationMs(scene.narration.text);
  const pageFrames = Math.max(1, Math.ceil(duration / 1000 * fps / pages)), page = Math.min(pages - 1, Math.floor(frame / pageFrames));
  const data = scene.data.slice(page * 6, page * 6 + 6);
  const progress = interpolate(frame - page * pageFrames, [0, Math.min(fps * 1.2, pageFrames * 0.6)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const { min, max } = chartDomain(scene.data), W = 1000, H = width < height ? 620 : 420;
  const left = 105, right = 40, top = 50, bottom = 120, graphW = W - left - right, graphH = H - top - bottom;
  const y = (value: number) => top + (max - value) / (max - min) * graphH;
  const x = (index: number) => left + graphW * (index + 0.5) / data.length;
  const points = data.map((item, index) => `${x(index)},${y(item.value * progress)}`).join(" ");
  return <>
    {scene.heading && <Heading>{scene.heading}</Heading>}
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={scene.heading ?? "数据图表"} style={{ width: "100%", maxHeight: "65%", overflow: "visible", color: "var(--glint-color-text)", fontFamily: "inherit" }}>
      {[min, (min + max) / 2, max].map((value, index) => <g key={index}>
        <line x1={left} x2={W - right} y1={y(value)} y2={y(value)} stroke="currentColor" opacity={0.12} />
        <text x={left - 15} y={y(value) + 7} textAnchor="end" fill="currentColor" fontSize={20}>{Number(value.toPrecision(3))}{scene.unit}</text>
      </g>)}
      <line x1={left} x2={W - right} y1={y(0)} y2={y(0)} stroke="currentColor" opacity={0.5} />
      {scene.chartType === "line" && <polyline points={points} fill="none" stroke="var(--glint-color-accent)" strokeWidth={5} strokeLinejoin="round" />}
      {data.map((item, index) => {
        const currentY = y(item.value * progress), zero = y(0), barW = Math.min(100, graphW / data.length * 0.58);
        const labels = Array.from(item.label).join("").match(/.{1,6}/gu) ?? [];
        return <g key={index}>
          <title>{item.label}: {item.value}{scene.unit}</title>
          {scene.chartType === "bar" ? <rect x={x(index) - barW / 2} y={Math.min(currentY, zero)} width={barW} height={Math.max(0.5, Math.abs(zero - currentY))} rx={5} fill="var(--glint-color-accent)" /> : <circle cx={x(index)} cy={currentY} r={6} fill="var(--glint-color-accent)" />}
          <text x={x(index)} y={currentY + (item.value < 0 ? 28 : -12)} textAnchor="middle" fill="currentColor" fontSize={scene.data.length > 12 ? 14 : 22}>{item.value}{scene.unit}</text>
          <text x={x(index)} y={H - bottom + 30} textAnchor="middle" fill="currentColor" fontSize={16}>{labels.map((label, line) => <tspan key={line} x={x(index)} dy={line ? 19 : 0}>{label}</tspan>)}</text>
        </g>;
      })}
    </svg>
    {pages > 1 && <small style={{ color: "var(--glint-color-text-muted)" }}>{page * 6 + 1}–{Math.min(scene.data.length, page * 6 + 6)} / {scene.data.length}</small>}
  </>;
}
