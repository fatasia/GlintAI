import { DEFAULT_NLE_TRANSITION_MS, nleDurationMs, parseNleProject, type NleProject } from "@glintai/scenescript";
import { canonicalJson } from "@glintai/session";

const MAX_TIMELINE_MS = 6 * 60 * 60 * 1000;
type TextEdit = { id: string; text?: string; startMs?: number; durationMs?: number; fontSize?: number; color?: string; weight?: 400 | 600 | 700 | 800; align?: "left" | "center" | "right" };
const permitted = new Set(["id", "text", "startMs", "durationMs", "fontSize", "color", "weight", "align"]);

/** Both API and browser call this against their own captured project snapshot. */
export function validateNleAiProposal(beforeInput: NleProject, afterInput: NleProject): NleProject {
  const before = parseNleProject(beforeInput), after = parseNleProject(afterInput), expected = structuredClone(before);
  for (const [trackIndex, track] of expected.tracks.entries()) {
    for (const [clipIndex, clip] of track.clips.entries()) {
      const proposed = after.tracks[trackIndex]?.clips[clipIndex];
      if (track.locked || clip.kind !== "text" || proposed?.kind !== "text" || proposed.id !== clip.id) continue;
      clip.text = proposed.text; clip.startMs = proposed.startMs; clip.durationMs = proposed.durationMs;
      if ("fontSize" in proposed) clip.fontSize = proposed.fontSize; else delete clip.fontSize;
      if ("color" in proposed) clip.color = proposed.color; else delete clip.color;
      if ("weight" in proposed) clip.weight = proposed.weight; else delete clip.weight;
      if ("align" in proposed) clip.align = proposed.align; else delete clip.align;
    }
  }
  if (canonicalJson(expected) !== canonicalJson(after)) throw new Error("模型提案超出未锁定文字片段的允许范围。");
  const limit = Math.min(nleDurationMs(before), MAX_TIMELINE_MS);
  for (const [trackIndex, oldTrack] of before.tracks.entries()) {
    const newTrack = after.tracks[trackIndex]!;
    const changed = oldTrack.clips.map((clip, index) => clip.startMs !== newTrack.clips[index]!.startMs || clip.durationMs !== newTrack.clips[index]!.durationMs);
    for (const [index, oldClip] of oldTrack.clips.entries()) {
      if (!changed[index]) continue;
      const clip = newTrack.clips[index]!;
      if (clip.startMs + clip.durationMs > limit) throw new Error("文字片段超出原时间轴范围。");
      if (clip.durationMs !== oldClip.durationMs) {
        if (oldClip.speedRamp || oldClip.speedCurve || oldClip.speed !== undefined || oldClip.trimStartMs !== undefined || (oldClip.kind === "text" && oldClip.karaoke)) throw new Error("带变速、源裁剪或卡拉 OK 的文字片段不能调整时长。");
        if (oldClip.keyframes?.some(frame => frame.ms >= clip.durationMs)) throw new Error("调整会截断已有关键帧。");
        const incoming = oldClip.transitionIn ? oldClip.transitionIn.durationMs ?? DEFAULT_NLE_TRANSITION_MS : 0;
        const outgoing = oldClip.transitionOut ? oldClip.transitionOut.durationMs ?? DEFAULT_NLE_TRANSITION_MS : 0;
        if (clip.durationMs < Math.min(incoming, oldClip.durationMs) || clip.durationMs < Math.min(outgoing, oldClip.durationMs) || Math.max(0, incoming + outgoing - clip.durationMs) > Math.max(0, incoming + outgoing - oldClip.durationMs)) throw new Error("调整会截断或新增重叠转场。");
      }
    }
    // Same-track overlap may only stay within an overlap already present in the snapshot.
    for (let a = 0; a < oldTrack.clips.length; a++) for (let b = a + 1; b < oldTrack.clips.length; b++) {
      if (!changed[a] && !changed[b]) continue;
      const left = oldTrack.clips[a]!, right = oldTrack.clips[b]!, nextLeft = newTrack.clips[a]!, nextRight = newTrack.clips[b]!;
      const oldStart = Math.max(left.startMs, right.startMs), oldEnd = Math.min(left.startMs + left.durationMs, right.startMs + right.durationMs);
      const nextStart = Math.max(nextLeft.startMs, nextRight.startMs), nextEnd = Math.min(nextLeft.startMs + nextLeft.durationMs, nextRight.startMs + nextRight.durationMs);
      if (nextStart < nextEnd && (oldStart >= oldEnd || nextStart < oldStart || nextEnd > oldEnd)) throw new Error("提案会产生或扩大同轨片段重叠。");
    }
  }
  return after;
}

export function applyNleAiEdits(input: NleProject, edits: unknown): NleProject {
  const before = parseNleProject(input);
  if (!Array.isArray(edits) || edits.length < 1 || edits.length > 30) throw new Error("模型没有给出可用的文字修改。");
  const available = new Map(before.tracks.flatMap(track => track.locked ? [] : track.clips.flatMap(clip => clip.kind === "text" ? [[clip.id, clip] as const] : [])));
  const patches = new Map<string, TextEdit>();
  for (const raw of edits) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some(key => !permitted.has(key))) throw new Error("模型返回了不支持的修改字段。");
    const edit = raw as TextEdit;
    if (typeof edit.id !== "string" || !available.has(edit.id) || patches.has(edit.id) || !["text", "startMs", "durationMs", "fontSize", "color", "weight", "align"].some(key => Object.hasOwn(edit, key))) throw new Error("模型返回了无效或不可修改的片段。");
    if (Object.hasOwn(edit, "text") && (typeof edit.text !== "string" || !edit.text.trim() || edit.text.length > 500)) throw new Error("模型返回的文字无效。");
    if (Object.hasOwn(edit, "startMs") && (!Number.isSafeInteger(edit.startMs) || edit.startMs! < 0 || edit.startMs! > MAX_TIMELINE_MS)) throw new Error("模型返回的起点无效。");
    if (Object.hasOwn(edit, "durationMs") && (!Number.isSafeInteger(edit.durationMs) || edit.durationMs! < 100 || edit.durationMs! > MAX_TIMELINE_MS)) throw new Error("模型返回的时长无效。");
    if (Object.hasOwn(edit, "fontSize") && (typeof edit.fontSize !== "number" || !Number.isFinite(edit.fontSize) || edit.fontSize < 12 || edit.fontSize > 240)) throw new Error("模型返回的字号无效。");
    if (Object.hasOwn(edit, "color") && (typeof edit.color !== "string" || !/^#[0-9a-f]{6}$/i.test(edit.color))) throw new Error("模型返回的颜色无效。");
    if (Object.hasOwn(edit, "weight") && ![400, 600, 700, 800].includes(edit.weight!)) throw new Error("模型返回的字重无效。");
    if (Object.hasOwn(edit, "align") && !["left", "center", "right"].includes(edit.align!)) throw new Error("模型返回的对齐方式无效。");
    patches.set(edit.id, edit);
  }
  const next = { ...before, tracks: before.tracks.map(track => ({ ...track, clips: track.clips.map(clip => {
    const patch = clip.kind === "text" && !track.locked ? patches.get(clip.id) : undefined;
    if (!patch) return clip;
    return { ...clip, ...(patch.text !== undefined ? { text: patch.text } : {}), ...(patch.startMs !== undefined ? { startMs: patch.startMs } : {}), ...(patch.durationMs !== undefined ? { durationMs: patch.durationMs } : {}), ...(patch.fontSize !== undefined ? { fontSize: patch.fontSize } : {}), ...(patch.color !== undefined ? { color: patch.color } : {}), ...(patch.weight !== undefined ? { weight: patch.weight } : {}), ...(patch.align !== undefined ? { align: patch.align } : {}) };
  }) })) };
  return validateNleAiProposal(before, parseNleProject(next));
}
