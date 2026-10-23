import { estimateNarrationDurationMs, type ChartScene, type ChartDataPoint } from "@glintai/scenescript";
import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { Heading } from "../components/Heading";

export function chartDomain(data: { value: number }[]) {
  const min = Math.min(0, ...data.map(item => item.value)), max = Math.max(0, ...data.map(item => item.value));
  return { min, max: min === max ? max + 1 : max };
}

/** Donut slices from positive values; negative inputs are clamped to 0. */
export function pieSlices(data: { value: number }[]) {
  const total = data.reduce((sum, item) => sum + Math.max(0, item.value), 0);
  let cursor = -Math.PI / 2;
  return data.map((item) => {
    const share = total > 0 ? Math.max(0, item.value) / total : 1 / data.length;
    const start = cursor;
    cursor += share * Math.PI * 2;
    return { start, end: cursor, share };
  });
}

function donutArc(cx: number, cy: number, rOuter: number, rInner: number, start: number, end: number) {
  // Sweep >359° would collapse into a zero-area ring; clamp to just under.
  const sweep = Math.min(end - start, Math.PI * 2 - 0.0001);
  const a0 = start, a1 = start + sweep;
  const large = sweep > Math.PI ? 1 : 0;
  const p = (radius: number, angle: number) => `${cx + radius * Math.cos(angle)},${cy + radius * Math.sin(angle)}`;
  return [
    `M ${p(rOuter, a0)}`,
    `A ${rOuter} ${rOuter} 0 ${large} 1 ${p(rOuter, a1)}`,
    `L ${p(rInner, a1)}`,
    `A ${rInner} ${rInner} 0 ${large} 0 ${p(rInner, a0)}`,
    "Z",
  ].join(" ");
}

const percent = (value: number) => {
  const rounded = Math.abs(value) >= 100 ? Math.round(value) : Number(value.toPrecision(3));
  return `${rounded}`;
};

/** Data stays editable; all animation is frame-derived and deterministic in MP4/export. */
export function ChartSceneView({ scene }: { scene: ChartScene }) {
  const frame = useCurrentFrame(), { fps, width, height } = useVideoConfig();
  const pages = scene.chartType === "pie" ? 1 : Math.ceil(scene.data.length / 6);
  const duration = scene.narration.durationMs ?? estimateNarrationDurationMs(scene.narration.text);
  const pageFrames = Math.max(1, Math.ceil(duration / 1000 * fps / pages)), page = Math.min(pages - 1, Math.floor(frame / pageFrames));
  const data = scene.data.slice(page * 6, page * 6 + 6);
  const progress = interpolate(frame - page * pageFrames, [0, Math.min(fps * 1.2, pageFrames * 0.6)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const W = 1000, H = width < height ? 620 : 420;
  const heading = scene.heading && <Heading>{scene.heading}</Heading>;

  if (scene.chartType === "pie") {
    const cx = W / 2, cy = H / 2, rOuter = Math.min(H / 2 - 60, 240), rInner = rOuter * 0.58;
    const slices = pieSlices(data);
    return <>
      {heading}
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={scene.heading ?? "数据图表"} style={{ width: "100%", maxHeight: "65%", overflow: "visible", color: "var(--glint-color-text)", fontFamily: "inherit" }}>
        {slices.map((slice, index) => {
          const eased = interpolate(progress, [index / data.length, Math.min(1, (index + 1.5) / data.length)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
          const mid = (slice.start + slice.end) / 2;
          return <g key={index}>
            <path d={donutArc(cx, cy, rOuter * (0.7 + 0.3 * eased), rInner, slice.start, slice.end)}
              fill={index % 2 ? "var(--glint-color-accent-2, var(--glint-color-accent))" : "var(--glint-color-accent)"}
              opacity={0.55 + 0.45 * eased} />
            <text x={cx + (rOuter + 46) * Math.cos(mid)} y={cy + (rOuter + 46) * Math.sin(mid) + 6}
              textAnchor={Math.cos(mid) > 0.2 ? "start" : Math.cos(mid) < -0.2 ? "end" : "middle"}
              fill="currentColor" fontSize={20} opacity={eased}>
              {data[index]!.label} · {Math.round(slice.share * 100)}%
            </text>
          </g>;
        })}
      </svg>
    </>;
  }

  const { min, max } = chartDomain(scene.data), left = 105, right = 40, top = 50, bottom = 120, graphW = W - left - right, graphH = H - top - bottom;
  const y = (value: number) => top + (max - value) / (max - min) * graphH;
  const x = (index: number) => left + graphW * (index + 0.5) / data.length;
  const points = data.map((item, index) => `${x(index)},${y(item.value * progress)}`).join(" ");

  const axisScaffold = <>
    {[min, (min + max) / 2, max].map((value, index) => <g key={index}>
      <line x1={left} x2={W - right} y1={y(value)} y2={y(value)} stroke="currentColor" opacity={0.12} />
      <text x={left - 15} y={y(value) + 7} textAnchor="end" fill="currentColor" fontSize={20}>{Number(value.toPrecision(3))}{scene.unit}</text>
    </g>)}
    <line x1={left} x2={W - right} y1={y(0)} y2={y(0)} stroke="currentColor" opacity={0.5} />
  </>;

  const xLabels = (items: ChartDataPoint[]) => items.map((item, index) => {
    const labels = Array.from(item.label).join("").match(/.{1,6}/gu) ?? [];
    return <text key={index} x={x(index)} y={H - bottom + 30} textAnchor="middle" fill="currentColor" fontSize={16}>
      {labels.map((label, line) => <tspan key={line} x={x(index)} dy={line ? 19 : 0}>{label}</tspan>)}
    </text>;
  });

  if (scene.chartType === "area") {
    const reveal = left + graphW * progress;
    const areaPath = `M ${x(0)},${y(0)} ${data.map((item, index) => `L ${x(index)},${y(item.value * progress)}`).join(" ")} L ${x(data.length - 1)},${y(0)} Z`;
    return <>
      {heading}
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={scene.heading ?? "数据图表"} style={{ width: "100%", maxHeight: "65%", overflow: "visible", color: "var(--glint-color-text)", fontFamily: "inherit" }}>
        {axisScaffold}
        <defs>
          <linearGradient id="glint-area-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--glint-color-accent)" stopOpacity={0.5} />
            <stop offset="100%" stopColor="var(--glint-color-accent)" stopOpacity={0.04} />
          </linearGradient>
          <clipPath id="glint-area-reveal"><rect x={left - 8} y={0} width={Math.max(0, reveal - left + 8)} height={H} /></clipPath>
        </defs>
        <g clipPath="url(#glint-area-reveal)">
          <path d={areaPath} fill="url(#glint-area-fill)" />
          <polyline points={points} fill="none" stroke="var(--glint-color-accent)" strokeWidth={5} strokeLinejoin="round" />
        </g>
        {data.map((item, index) => <circle key={index} cx={x(index)} cy={y(item.value * progress)} r={6} fill="var(--glint-color-accent)"
          opacity={progress * data.length > index ? 1 : 0} />)}
        {xLabels(data)}
      </svg>
      {pages > 1 && <small style={{ color: "var(--glint-color-text-muted)" }}>{page * 6 + 1}–{Math.min(scene.data.length, page * 6 + 6)} / {scene.data.length}</small>}
    </>;
  }

  if (scene.chartType === "scatter") {
    const values = data.map((item) => item.value);
    const xMin = Math.min(...values), xMax = Math.max(...values), xSpan = xMax - xMin || 1;
    const y2s = data.map((item) => item.value2 ?? 0);
    const yMin = Math.min(0, ...y2s), yMaxRaw = Math.max(...y2s), yMax = yMaxRaw === yMin ? yMaxRaw + 1 : yMaxRaw;
    const y2 = (value: number) => top + (yMax - value) / (yMax - yMin) * graphH;
    const x2 = (value: number) => left + (value - xMin) / xSpan * graphW;
    const xTicks = [xMin, (xMin + xMax) / 2, xMax];
    return <>
      {heading}
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={scene.heading ?? "数据图表"} style={{ width: "100%", maxHeight: "65%", overflow: "visible", color: "var(--glint-color-text)", fontFamily: "inherit" }}>
        {/* Scatter owns both axes: X spans the `value` domain, Y the `value2` domain. */}
        {[yMin, (yMin + yMax) / 2, yMax].map((value, index) => <g key={index}>
          <line x1={left} x2={W - right} y1={y2(value)} y2={y2(value)} stroke="currentColor" opacity={0.12} />
          <text x={left - 15} y={y2(value) + 7} textAnchor="end" fill="currentColor" fontSize={20}>{Number(value.toPrecision(3))}{scene.unit}</text>
        </g>)}
        <line x1={left} x2={W - right} y1={y2(0)} y2={y2(0)} stroke="currentColor" opacity={0.5} />
        {xTicks.map((value, index) => <text key={index} x={x2(value)} y={H - bottom + 30} textAnchor="middle" fill="currentColor" fontSize={16}>{Number(value.toPrecision(3))}</text>)}
        {scene.seriesLabel2 && <text x={left} y={top - 22} textAnchor="start" fill="currentColor" fontSize={18} opacity={0.7}>y: {scene.seriesLabel2}</text>}
        {data.map((item, index) => {
          const pop = interpolate(progress, [index / data.length, Math.min(1, (index + 1.6) / data.length)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
          return <g key={index}>
            <title>{item.label}: ({item.value}, {item.value2})</title>
            <circle cx={x2(item.value)} cy={y2(item.value2 ?? 0)} r={7 + 9 * (1 - pop)} fill="var(--glint-color-accent)" opacity={pop} />
            <text x={x2(item.value)} y={y2(item.value2 ?? 0) - 16} textAnchor="middle" fill="currentColor" fontSize={16} opacity={pop}>{item.label}</text>
          </g>;
        })}
      </svg>
    </>;
  }

  if (scene.chartType === "combo") {
    const y2s = data.map((item) => item.value2 ?? 0);
    const y2Min = Math.min(0, ...y2s), y2MaxRaw = Math.max(...y2s), y2Max = y2MaxRaw === y2Min ? y2MaxRaw + 1 : y2MaxRaw;
    const y2 = (value: number) => top + (y2Max - value) / (y2Max - y2Min) * graphH;
    const linePoints = data.map((item, index) => `${x(index)},${y2((item.value2 ?? 0) * progress)}`).join(" ");
    return <>
      {heading}
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={scene.heading ?? "数据图表"} style={{ width: "100%", maxHeight: "65%", overflow: "visible", color: "var(--glint-color-text)", fontFamily: "inherit" }}>
        {axisScaffold}
        {[y2Min, (y2Min + y2Max) / 2, y2Max].map((value, index) => <text key={index} x={W - right + 12} y={y2(value) + 7} textAnchor="start" fill="currentColor" fontSize={20} opacity={0.6}>{Number(value.toPrecision(3))}</text>)}
        {scene.seriesLabel2 && <text x={W - right + 12} y={top - 22} textAnchor="start" fill="currentColor" fontSize={16} opacity={0.7}>{scene.seriesLabel2}</text>}
        {data.map((item, index) => {
          const currentY = y(item.value * progress), zero = y(0), barW = Math.min(100, graphW / data.length * 0.5);
          return <g key={index}>
            <title>{item.label}: {item.value}{scene.unit}</title>
            <rect x={x(index) - barW / 2} y={Math.min(currentY, zero)} width={barW} height={Math.max(0.5, Math.abs(zero - currentY))} rx={5} fill="var(--glint-color-accent)" opacity={0.85} />
          </g>;
        })}
        <polyline points={linePoints} fill="none" stroke="var(--glint-color-accent-2, var(--glint-color-accent))" strokeWidth={5} strokeLinejoin="round" />
        {data.map((item, index) => <circle key={index} cx={x(index)} cy={y2((item.value2 ?? 0) * progress)} r={7} fill="var(--glint-color-accent-2, var(--glint-color-accent))" />)}
        {xLabels(data)}
      </svg>
      {pages > 1 && <small style={{ color: "var(--glint-color-text-muted)" }}>{page * 6 + 1}–{Math.min(scene.data.length, page * 6 + 6)} / {scene.data.length}</small>}
    </>;
  }

  // bar | line — original path, untouched.
  return <>
    {heading}
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={scene.heading ?? "数据图表"} style={{ width: "100%", maxHeight: "65%", overflow: "visible", color: "var(--glint-color-text)", fontFamily: "inherit" }}>
      {axisScaffold}
      {scene.chartType === "line" && <polyline points={points} fill="none" stroke="var(--glint-color-accent)" strokeWidth={5} strokeLinejoin="round" />}
      {data.map((item, index) => {
        const currentY = y(item.value * progress), zero = y(0), barW = Math.min(100, graphW / data.length * 0.58);
        const labels = Array.from(item.label).join("").match(/.{1,6}/gu) ?? [];
        return <g key={index}>
          <title>{item.label}: {item.value}{scene.unit}</title>
          {scene.chartType === "bar" ? <rect x={x(index) - barW / 2} y={Math.min(currentY, zero)} width={barW} height={Math.max(0.5, Math.abs(zero - currentY))} rx={5} fill="var(--glint-color-accent)" /> : <circle cx={x(index)} cy={currentY} r={6} fill="var(--glint-color-accent)" />}
          <text x={x(index)} y={currentY + (item.value < 0 ? 28 : -12)} textAnchor="middle" fill="currentColor" fontSize={scene.data.length > 12 ? 14 : 22}>{percent(item.value)}{scene.unit}</text>
          <text x={x(index)} y={H - bottom + 30} textAnchor="middle" fill="currentColor" fontSize={16}>{labels.map((label, line) => <tspan key={line} x={x(index)} dy={line ? 19 : 0}>{label}</tspan>)}</text>
        </g>;
      })}
    </svg>
    {pages > 1 && <small style={{ color: "var(--glint-color-text-muted)" }}>{page * 6 + 1}–{Math.min(scene.data.length, page * 6 + 6)} / {scene.data.length}</small>}
  </>;
}
