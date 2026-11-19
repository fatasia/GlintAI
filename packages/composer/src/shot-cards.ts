/**
 * Shot recipe card catalogue (methodology adopted from video-shotcraft's card
 * format; every card below is written from Glint's own NLE primitives, no
 * upstream code or copy). A card is a reusable motion vocabulary entry: what
 * it is for, the parameter table, and the known traps that must not be tuned
 * down. Cards are data — the editor renders them with existing primitives.
 */
import { z } from "zod";

export const ShotCategory = z.enum(["opening", "camera", "transition", "typography", "ui-entrance", "interaction", "data", "emphasis", "rhythm", "outro"]);
export type ShotCategory = z.infer<typeof ShotCategory>;

export const ShotCard = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,60}$/),
  name: z.string().min(1).max(60),
  category: ShotCategory,
  /** One-line pitch shown in the library browser. */
  summary: z.string().min(1).max(200),
  /** Typical clip length in ms; the timeline may trim freely. */
  typicalMs: z.number().int().min(200).max(60_000),
  /** High / medium / low — the energy-curve slot this card fits. */
  energy: z.enum(["high", "medium", "low"]),
  /** Parameters the card exposes; values are defaults, timelines may override. */
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  /** Traps that must not be tuned down; enforcement lives in craft checks. */
  knownTraps: z.array(z.string().max(200)).max(10).default([]),
}).strict();
export type ShotCard = z.infer<typeof ShotCard>;

/**
 * The opening set. Cards describe intent, not pixels — the composer renders
 * them through SceneScript scenes, so every card stays theme-agnostic.
 */
export const SHOT_CARDS: readonly ShotCard[] = [
  {
    id: "brand-hold-open", name: "品牌定格开场", category: "opening",
    summary: "品牌字标落定后静止 ≥1s 再进入内容；开场只给一个主角与一条完整动作弧。",
    typicalMs: 3600, energy: "low",
    params: { holdMs: 1000, arcMs: 2600 },
    knownTraps: ["开场信息宁少而聚焦，多元素并舞撑不起第一印象", "节奏宁慢勿快：初版默认放慢一档"],
  },
  {
    id: "energy-ramp-cut", name: "能量爬升切换", category: "transition",
    summary: "高能量镜与稳节奏镜交替；批量入场用越快越快的硬加速并留 0.5s 静止。",
    typicalMs: 1200, energy: "high",
    params: { accelerate: true, restMs: 500 },
    knownTraps: ["匀速直线运动读作廉价幻灯片", "连续高能量镜读作嘈杂，交替与字卡就是节奏本身"],
  },
  {
    id: "type-and-filter", name: "输入即筛选", category: "interaction",
    summary: "模拟真人操作速度的 type-and-filter 演示，观众要能跟着做一遍。",
    typicalMs: 4000, energy: "medium",
    params: { typingMs: 1800, filterMs: 1200 },
    knownTraps: ["交互演示按真人操作速度走，不加速"],
  },
  {
    id: "flash-cut", name: "推进流白", category: "transition",
    summary: "切点跨骑一层白闪盖住换页；白闪只盖硬切，不当装饰光效。",
    typicalMs: 350, energy: "high",
    params: { flashFrames: 5 },
    knownTraps: ["一个接缝只用一式；白闪不当装饰光效群发"],
  },
  {
    id: "caption-breath", name: "呼吸字卡", category: "rhythm",
    summary: "每 1–2 个功能镜头后插入的停顿字卡，给关键信息 ≥1s 静止。",
    typicalMs: 1800, energy: "low",
    params: { holdMs: 1000 },
    knownTraps: ["字卡与收尾文案重复即删"],
  },
  {
    id: "group-photo-outro", name: "合影收场", category: "outro",
    summary: "已展示功能各出代表元素多方向飞入围住字标，能量推到全片峰值。",
    typicalMs: 4200, energy: "high",
    params: { flyInMs: 1400, holdMs: 1200 },
    knownTraps: ["初版收尾几乎总是偏保守，默认加码一档"],
  },
];

export function shotCardById(id: string): ShotCard | undefined {
  return SHOT_CARDS.find(card => card.id === id);
}

/** Energy arc (promo-energy-arc methodology): slot shares for a default film. */
export interface EnergyArcSlot { slot: "opening" | "hero" | "climb" | "breath" | "outro"; sharePct: number }
export const ENERGY_ARC: readonly EnergyArcSlot[] = [
  { slot: "opening", sharePct: 10 },
  { slot: "hero", sharePct: 14 },
  { slot: "climb", sharePct: 60 },
  { slot: "breath", sharePct: 0 },
  { slot: "outro", sharePct: 16 },
];

/** Distribute totalMs across the arc; breath cards are carved from climb. */
export function planEnergyArc(totalMs: number, featureScenes: number): Array<{ slot: EnergyArcSlot["slot"]; startMs: number; durationMs: number }> {
  const total = Math.max(1000, Math.round(totalMs));
  const breathCount = Math.max(0, Math.min(4, Math.floor(featureScenes / 2)));
  const breathEach = breathCount ? 1800 : 0;
  const share = (slot: EnergyArcSlot["slot"]): number => ENERGY_ARC.find(item => item.slot === slot)?.sharePct ?? 0;
  const opening = Math.round(total * share("opening") / 100);
  const hero = Math.round(total * share("hero") / 100);
  const outro = Math.round(total * share("outro") / 100);
  const climb = Math.max(1000, total - opening - hero - outro - breathEach * breathCount);
  const plan: Array<{ slot: EnergyArcSlot["slot"]; startMs: number; durationMs: number }> = [
    { slot: "opening", startMs: 0, durationMs: opening },
    { slot: "hero", startMs: opening, durationMs: hero },
  ];
  const breathEvery = breathCount ? Math.floor(climb / (breathCount + 1)) : climb + 1;
  let cursor = opening + hero;
  for (let index = 0; index < breathCount; index++) {
    const before = Math.max(1000, breathEvery - breathEach);
    plan.push({ slot: "climb", startMs: cursor, durationMs: before });
    cursor += before;
    plan.push({ slot: "breath", startMs: cursor, durationMs: breathEach });
    cursor += breathEach;
  }
  const finalClimb = Math.max(1000, total - cursor - outro);
  plan.push({ slot: "climb", startMs: cursor, durationMs: finalClimb });
  cursor += finalClimb;
  plan.push({ slot: "outro", startMs: cursor, durationMs: outro });
  return plan.filter(slot => slot.durationMs > 0);
}
