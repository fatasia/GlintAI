import { buildTimeline, type SceneScriptProject } from "@glintai/scenescript";
import { reviewProject } from "./quality";
import { craftLint, lintVerdict } from "./craft-lint";

/**
 * QA-02 blind review: score projects on structural + craft metrics with all
 * identity stripped (titles/ids never enter the report), so a preference
 * between two versions cannot be biased by naming.
 */

export interface BlindMetrics {
  scenes: number;
  totalSeconds: number;
  /** Narration characters per second — pacing density. */
  charsPerSecond: number;
  /** Quality review flags (hedging, filler, unexplained numbers...). */
  reviewFlags: number;
  /** Craft lint issues; verdict is green/yellow/red. */
  lintIssues: number;
  lintVerdict: "green" | "yellow" | "red";
  /** Share of narration text that repeats an earlier sentence verbatim. */
  repeatedRatio: number;
}

const narrationText = (project: SceneScriptProject): string[] =>
  project.scenes.map(scene => scene.narration.text.trim()).filter(Boolean);

export function blindMetrics(project: SceneScriptProject): BlindMetrics {
  const texts = narrationText(project);
  const characters = texts.reduce((sum, text) => sum + text.length, 0);
  // Scene narration.durationMs is optional (set by compose); the timeline total
  // is the same number both renderers use, so pacing stays comparable.
  const totalSeconds = buildTimeline(project).totalMs / 1000;
  const seen = new Set<string>();
  let repeated = 0;
  for (const text of texts) {
    if (seen.has(text)) repeated += text.length;
    else seen.add(text);
  }
  const review = reviewProject(project, "");
  const issues = craftLint(project);
  return {
    scenes: project.scenes.length,
    totalSeconds: Math.round(totalSeconds * 10) / 10,
    charsPerSecond: totalSeconds > 0 ? Math.round(characters / totalSeconds * 100) / 100 : 0,
    reviewFlags: review.flagged,
    lintIssues: issues.length,
    lintVerdict: lintVerdict(issues),
    repeatedRatio: characters > 0 ? Math.round(repeated / characters * 1000) / 1000 : 0,
  };
}

const METRIC_LABELS: Record<keyof Omit<BlindMetrics, "lintVerdict">, { label: string; better: "low" | "high" | "none" }> = {
  scenes: { label: "镜头数", better: "low" },
  totalSeconds: { label: "总时长 s", better: "low" },
  /** Pacing is a band (too fast reads rushed, too slow drags) — shown, never scored. */
  charsPerSecond: { label: "语速 字/s", better: "none" },
  reviewFlags: { label: "评审旗标", better: "low" },
  lintIssues: { label: "文案问题", better: "low" },
  repeatedRatio: { label: "重复率", better: "low" },
};

/**
 * Identity-free A/B comparison. Every metric lists both sides and which one
 * wins (ties stay ties); the caller shows the mapping only after the reviewer
 * has stated a preference.
 */
export function blindCompare(a: BlindMetrics, b: BlindMetrics): { rows: Array<{ metric: string; A: number | string; B: number | string; winner: "A" | "B" | "tie" }>; summary: string } {
  const keys = Object.keys(METRIC_LABELS) as Array<keyof typeof METRIC_LABELS>;
  const rows = keys.map(key => {
    const { label } = METRIC_LABELS[key];
    const left = a[key] as number, right = b[key] as number;
    const better = METRIC_LABELS[key].better;
    const winner: "A" | "B" | "tie" = better === "none" || left === right ? "tie" : (better === "low" ? left < right : left > right) ? "A" : "B";
    return { metric: label, A: left, B: right, winner };
  });
  const aWins = rows.filter(row => row.winner === "A").length;
  const bWins = rows.filter(row => row.winner === "B").length;
  const summary = aWins === bWins ? `平手（A ${aWins} : B ${bWins}）` : `${aWins > bWins ? "A" : "B"} 领先（A ${aWins} : B ${bWins}，指标 ${rows.length} 项）`;
  return { rows, summary };
}

/** Score distribution across a batch: per-metric min/median/max. */
export function scoreDistribution(projects: ReadonlyArray<SceneScriptProject>): { count: number; metrics: Array<{ metric: string; min: number; median: number; max: number }> } {
  const all = projects.map(blindMetrics);
  const keys = Object.keys(METRIC_LABELS) as Array<keyof typeof METRIC_LABELS>;
  const median = (values: number[]) => {
    const sorted = [...values].sort((x, y) => x - y);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle]! : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2 * 100) / 100;
  };
  return {
    count: all.length,
    metrics: keys.map(key => {
      const values = all.map(item => item[key] as number);
      return { metric: METRIC_LABELS[key].label, min: Math.min(...values), median: median(values), max: Math.max(...values) };
    }),
  };
}
