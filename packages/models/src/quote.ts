import type { ModelRegistry } from "./registry";
import type { ModelEntry, ModelKind } from "./schema";

/** What a generation will consume. Unused fields are zero. */
export interface Usage {
  calls?: number;
  images?: number;
  seconds?: number;
  chars?: number;
}

export interface Quote {
  modelId: string;
  /** null when the price is unknown; never a guess. */
  costCny: number | null;
  basis: ModelEntry["pricing"]["basis"];
  /** Human-readable arithmetic, shown next to the number. */
  explain: string;
}

const round = (value: number) => Math.round(value * 10_000) / 10_000;

export function quote(entry: ModelEntry, usage: Usage): Quote {
  const pricing = entry.pricing;
  const base = { modelId: entry.id, basis: pricing.basis };
  switch (pricing.basis) {
    case "free-local": return { ...base, costCny: 0, explain: "本机运行，不产生费用" };
    case "unknown": return { ...base, costCny: null, explain: "未填写单价，无法估算" };
    case "per-call": { const n = usage.calls ?? 0; return { ...base, costCny: round(n * pricing.amountCny), explain: `${n} 次 × ¥${pricing.amountCny}` }; }
    case "per-image": { const n = usage.images ?? 0; return { ...base, costCny: round(n * pricing.amountCny), explain: `${n} 张 × ¥${pricing.amountCny}` }; }
    case "per-second": { const n = usage.seconds ?? 0; return { ...base, costCny: round(n * pricing.amountCny), explain: `${n} 秒 × ¥${pricing.amountCny}` }; }
    case "per-1k-chars": { const n = usage.chars ?? 0; return { ...base, costCny: round((n / 1000) * pricing.amountCny), explain: `${n} 字 ÷ 1000 × ¥${pricing.amountCny}` }; }
  }
}

export interface BudgetLine { label: string; quote: Quote }

export interface BudgetCheck {
  ok: boolean;
  /** Sum of the lines whose price is known. */
  knownCny: number;
  unknown: string[];
  reason?: "over-budget" | "unknown-cost";
  capCny?: number;
}

/**
 * Spend is approved before it happens. An unknown price blocks by default, because
 * "we could not tell" must never read as "it is free".
 */
export function checkBudget(lines: readonly BudgetLine[], options: { capCny?: number; allowUnknown?: boolean } = {}): BudgetCheck {
  const unknown = lines.filter(line => line.quote.costCny === null).map(line => line.label);
  const knownCny = round(lines.reduce((sum, line) => sum + (line.quote.costCny ?? 0), 0));
  const result: BudgetCheck = { ok: true, knownCny, unknown, capCny: options.capCny };
  if (options.capCny !== undefined && knownCny > options.capCny) return { ...result, ok: false, reason: "over-budget" };
  if (unknown.length && !options.allowUnknown) return { ...result, ok: false, reason: "unknown-cost" };
  return result;
}

export interface Requirement {
  kind: ModelKind;
  requires?: readonly string[];
  usage: Usage;
  maxCostCny?: number;
  preferLocal?: boolean;
  aspect?: "16:9" | "9:16" | "1:1";
  durationSec?: number;
}

export interface Ranked { entry: ModelEntry; quote: Quote; score: number; reasons: string[] }
export interface Rejected { id: string; reason: string }
export interface Selection { ranked: Ranked[]; rejected: Rejected[] }

/**
 * Ranks every model that can do the job and says why each other one cannot.
 * The result is the audit trail: the same registry and requirement always give the same order.
 */
export function selectModels(registry: ModelRegistry, requirement: Requirement): Selection {
  const ranked: Ranked[] = [];
  const rejected: Rejected[] = [];
  for (const entry of registry.entries) {
    if (entry.kind !== requirement.kind) continue;
    const missing = (requirement.requires ?? []).filter(capability => !entry.capabilities.includes(capability));
    if (missing.length) { rejected.push({ id: entry.id, reason: `缺少能力：${missing.join("、")}` }); continue; }
    if (requirement.aspect && entry.limits.aspects && !entry.limits.aspects.includes(requirement.aspect)) { rejected.push({ id: entry.id, reason: `不支持画幅 ${requirement.aspect}` }); continue; }
    if (requirement.durationSec !== undefined && entry.limits.maxDurationSec !== undefined && requirement.durationSec > entry.limits.maxDurationSec) { rejected.push({ id: entry.id, reason: `单次最长 ${entry.limits.maxDurationSec} 秒，需要 ${requirement.durationSec} 秒` }); continue; }
    const q = quote(entry, requirement.usage);
    if (requirement.maxCostCny !== undefined && q.costCny !== null && q.costCny > requirement.maxCostCny) { rejected.push({ id: entry.id, reason: `预计 ¥${q.costCny}，超过上限 ¥${requirement.maxCostCny}` }); continue; }
    const reasons: string[] = [];
    let score = 0;
    if (entry.pricing.basis === "free-local") { score += requirement.preferLocal ? 1000 : 100; reasons.push("本机运行，免费"); }
    if (q.costCny === null) { score -= 50; reasons.push("价格未知"); }
    else { score -= Math.min(q.costCny, 900); reasons.push(`预计 ¥${q.costCny}`); }
    ranked.push({ entry, quote: q, score, reasons });
  }
  ranked.sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id));
  return { ranked, rejected };
}
