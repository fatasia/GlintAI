import { buildTimeline, parseNleProject, parseProject, type NleProject, type SceneScriptProject } from "@glintai/scenescript";
import { canonicalJson } from "@glintai/session";
import { describeProposal } from "./NleProposal";
import type { ChatContext, ChatKind, ChatProject } from "./local-agent-chat-model";
import { artifactDiff, parseArtifactProject, validateArtifactProposal, type ArtifactProject, type ArtifactSelection } from "./artifact-project";

export type ReadableChange = { label: string; path: string; before: unknown; after: unknown; timeMs?: number };
export type ChatProposal = { id: number; next: ChatProject; base: string; changes: ReadableChange[] };
export const captureProject = (project: ChatProject): ChatProject => JSON.parse(JSON.stringify(project)) as ChatProject;
// 捕获记录存在但 context 为 undefined 表示已知全文；无记录表示历史范围未知。
export type ChatTurnCapture = { project: ChatProject; context: ChatContext | undefined };
export const captureChatContext = (context?: ChatContext): ChatContext | undefined => context === undefined ? undefined : JSON.parse(JSON.stringify(context)) as ChatContext;
export async function projectDigest(project: ChatProject): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("当前环境无法校验历史提案，请基于当前工程重新提出要求。");
  const data = new TextEncoder().encode(canonicalJson(captureProject(project)));
  const hash = await globalThis.crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
export function validateChatProposal(kind: ChatKind, before: ChatProject, value: unknown, selection?: ArtifactSelection): ChatProject {
  if (kind === "design" || kind === "script") return validateArtifactProposal(parseArtifactProject(before, before.id, kind), value, selection);
  let next: ChatProject;
  try { next = kind === "scene" ? parseProject(value) : parseNleProject(value); }
  catch { throw new Error("提案格式不正确，工程未修改。请让智能体重新生成。"); }
  if (next.id !== before.id || next.schemaVersion !== before.schemaVersion) throw new Error("提案属于其他工程，不能应用。");
  if ("frozen" in before && before.frozen && !same(before, next)) throw new Error("工程已冻结，不能应用修改。");
  if (kind === "scene") {
    const base = before as SceneScriptProject, proposed = next as SceneScriptProject;
    const starts = new Map(buildTimeline(proposed).entries.map(entry => [entry.scene.id, entry.startMs]));
    const originalTimeline = buildTimeline(base).entries;
    for (const [index, scene] of base.scenes.entries()) if (scene.locked && (!same(scene, proposed.scenes[index]) || starts.get(scene.id) !== originalTimeline[index]?.startMs)) throw new Error(`镜头 ${index + 1} 已锁定，不能修改、删除或移动。`);
    for (const asset of base.assets ?? []) if ((asset.approval || (asset as { locked?: boolean }).locked) && !same(asset, proposed.assets?.find(item => item.id === asset.id))) throw new Error("提案修改了已审批或锁定素材，不能应用。");
  } else {
    const base = before as NleProject, proposed = next as NleProject;
    for (const [index, track] of base.tracks.entries()) if (track.locked && !same(track, proposed.tracks[index])) throw new Error(`轨道「${track.name}」已锁定，不能修改、删除或移动。`);
  }
  return next;
}
const names: Record<string, string> = { title: "标题", text: "文字", narration: "旁白", durationMs: "时长", startMs: "起点", name: "名称", fontSize: "字号", color: "颜色", transform: "画面位置", x: "水平位置", y: "垂直位置", scale: "缩放", rotate: "旋转", opacity: "透明度", tracks: "轨道", clips: "片段", scenes: "镜头", assets: "素材", fps: "帧率", width: "画布宽", height: "画布高", background: "背景", aspect: "画幅", kind: "类型", trimStartMs: "素材起点", volume: "音量", effects: "效果", transitionIn: "入场", transitionOut: "出场", locked: "锁定", music: "配乐", theme: "主题", knowledgeSources: "知识来源" };
function humanPath(path: string[], before: ChatProject, after: ChatProject): string {
  const parts: string[] = [];
  let source: unknown = after;
  for (let i = 0; i < path.length; i++) {
    const key = path[i]!;
    if (key === "tracks" && path[i + 1] !== undefined) {
      const index = Number(path[++i]), track = (after as NleProject).tracks[index] ?? (before as NleProject).tracks[index];
      parts.push(`轨道「${track?.name ?? index + 1}」`); source = track;
    } else if (key === "scenes" && path[i + 1] !== undefined) { const index = Number(path[++i]); parts.push(`镜头 ${index + 1}`); }
    else if (key === "clips" && path[i + 1] !== undefined) { const index = Number(path[++i]); parts.push(`片段 ${index + 1}`); source = (source as { clips?: unknown[] })?.clips?.[index]; }
    else parts.push(names[key] ?? (/^\d+$/.test(key) ? `第 ${Number(key) + 1} 项` : "内容"));
  }
  return parts.join(" · ");
}
export function readableChanges(kind: ChatKind, before: ChatProject, after: ChatProject): ReadableChange[] {
  if (kind === "design" || kind === "script") return artifactDiff((before as ArtifactProject).document, (after as ArtifactProject).document).map(change => ({ ...change, path: change.label }));
  if (kind === "nle") return describeProposal(before as NleProject, after as NleProject).map(change => {
    const path = change.path.split(" / "), track = (after as NleProject).tracks[Number(path[1])];
    return { ...change, label: `${change.kind} · ${humanPath(path, before, after)}`, timeMs: path[0] === "tracks" && path[2] === "clips" ? track?.clips[Number(path[3])]?.startMs : undefined };
  });
  const changes: ReadableChange[] = [];
  const walk = (a: unknown, b: unknown, path: string[]) => {
    if (same(a, b)) return;
    if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
      const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
      for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) walk(left[key], right[key], [...path, key]);
    } else if (path.length === 1 && path[0] === "scenes" && Array.isArray(a) && Array.isArray(b)) {
      for (let index = 0; index < Math.max(a.length, b.length); index++) walk(a[index], b[index], [...path, String(index)]);
    } else changes.push({ path: path.join(" / "), label: humanPath(path, before, after), before: a, after: b });
  };
  walk(before, after, []); return changes;
}
export function makeChatProposal(id: number, kind: ChatKind, base: ChatProject, value: unknown, selection?: ArtifactSelection): ChatProposal {
  const next = validateChatProposal(kind, base, value, selection), changes = readableChanges(kind, base, next);
  if (!changes.length) throw new Error("提案与工程一致，没有需要应用的修改。");
  return { id, next, base: canonicalJson(base), changes };
}
export function changeValue(value: unknown): string {
  if (value === undefined) return "无";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return `${value.length} 项内容`;
  return "结构内容（展开技术细节查看）";
}
