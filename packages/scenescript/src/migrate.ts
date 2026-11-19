import { parseProject } from "./parse";
import type { SceneScriptProject } from "./types";
import type { SceneScriptProject as Project } from "./types";

/**
 * CORE-06 旧工程迁移（ADR-010）：单一当前版本 + 显式迁移函数。
 * 当前版本工程原样通过；历史形态逐级修补后交 schema 校验；未来版本显式拒绝，
 * 绝不静默降级。迁移是纯函数——调用方负责在写入前留存原文件副本。
 */
export interface MigrationResult { project: Project; migrated: boolean; notes: string[] }

/** Best-effort narration duration from text length (~4 chars/s), min 1s. */
const estimateDurationMs = (text: string) => Math.max(1000, Math.ceil((text || " ").length / 4) * 250);

function migrateV0ToV1(input: Record<string, unknown>, notes: string[]): Record<string, unknown> {
  const next = structuredClone(input);
  next.schemaVersion = 1;
  if (!Array.isArray(next.knowledgeSources)) { next.knowledgeSources = []; notes.push("knowledgeSources 缺失，补为空数组"); }
  if (!Array.isArray(next.scenes) || !next.scenes.length) throw new Error("工程没有 scenes 数组，无法迁移；确认这是 Glint 工程文件。");
  next.scenes = (next.scenes as Record<string, unknown>[]).map((scene, index) => {
    const patched = { ...scene };
    if (!patched.kind) {
      patched.kind = "bullets";
      patched.items = [String(patched.title ?? patched.text ?? "内容")];
      notes.push(`scenes[${index}].kind 缺失，补为 bullets 并以标题建条目`);
    }
    if (!patched.narration || typeof patched.narration !== "object") {
      patched.narration = { text: String(patched.text ?? patched.title ?? ""), durationMs: 2000 };
      notes.push(`scenes[${index}].narration 缺失，按标题补最小旁白`);
    }
    const narration = patched.narration as Record<string, unknown>;
    if (!Number.isFinite(Number(narration.durationMs)) || Number(narration.durationMs) <= 0) {
      narration.durationMs = estimateDurationMs(String(narration.text ?? ""));
      notes.push(`scenes[${index}].narration.durationMs 缺失，按文本长度估为 ${narration.durationMs}ms`);
    }
    return patched;
  });
  if (next.music && typeof next.music === "object" && !Number.isFinite(Number((next.music as Record<string, unknown>).volume))) {
    (next.music as Record<string, unknown>).volume = 0.3;
    notes.push("music.volume 缺失，补为 0.3");
  }
  return next;
}

export function migrateProject(input: unknown): MigrationResult {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const version = (input as Record<string, unknown>).schemaVersion;
    if (version === 1) {
      try { parseProject(input as Project); return { project: input as Project, migrated: false, notes: [] }; }
      catch (error) {
        // A v1-labelled document that fails the current schema may predate a
        // field rename; run it through the same repair pass rather than refuse.
        const notes = [`schemaVersion 1 未通过当前校验，尝试修补：${error instanceof Error ? error.message.split("\n")[0] : "unknown"}`];
        const project = parseProject(migrateV0ToV1(input as Record<string, unknown>, notes) as unknown as Project);
        return { project, migrated: true, notes };
      }
    }
    if (typeof version === "number" && version > 1) {
      throw new Error(`工程 schemaVersion 为 ${version}，来自更新版本的 Glint；请先升级 Glint 再打开，本版本不会静默降级。`);
    }
    const notes: string[] = [`schemaVersion 缺失（${version === undefined ? "无字段" : String(version)}），按最早历史形态迁移到 1`];
    const project = parseProject(migrateV0ToV1(input as Record<string, unknown>, notes) as unknown as Project);
    return { project, migrated: true, notes };
  }
  throw new Error("工程必须是 JSON 对象；迁移拒绝处理数组或标量。");
}
