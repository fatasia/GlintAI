import { recoveryKey } from "./legacy-recovery-keys.mjs";

export const RECOVERY_JOURNAL = "glint:legacy-recovery:journal:v1";
export const RECOVERY_BACKUP = "glint:legacy-recovery:backup:v1";
export type RecoveryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type LegacySnapshot = { version: 1; origin: string; exportedAt: string; values: Record<string, string> };
export type RecoveryEntry = { key: string; before: string | null; after: string | null };
type Journal = { version: 1; state: "prepared" | "committed"; entries: RecoveryEntry[] };
const MAX_BYTES = 4 * 1024 * 1024;
const size = (raw: string) => new TextEncoder().encode(raw).length;
export function parseLegacySnapshot(raw: string): LegacySnapshot {
  if (size(raw) > MAX_BYTES) throw new Error("恢复文件超过 4 MB，请先拆分并核对备份。");
  const value = JSON.parse(raw) as LegacySnapshot;
  if (!value || value.version !== 1 || typeof value.origin !== "string" || !/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(value.origin) ||
    Number(new URL(value.origin).port) < 1024 || typeof value.exportedAt !== "string" || !value.values || Array.isArray(value.values) || typeof value.values !== "object" || Object.keys(value.values).length > 1500)
    throw new Error("不是受支持的旧客户端备份。");
  for (const [key, content] of Object.entries(value.values)) {
    if (!recoveryKey(key) || typeof content !== "string") throw new Error("备份含有未知存储键；未写入任何数据。");
    if (key === "glint:theme") { if (!["light", "dark"].includes(content)) throw new Error("主题记录无效。"); }
    else { try { JSON.parse(content); } catch { throw new Error(`记录 ${key} 不是有效 JSON，请保留原备份核对。`); } }
  }
  return value;
}
export function previewLegacySnapshot(snapshot: LegacySnapshot, storage: RecoveryStorage): RecoveryEntry[] {
  return Object.entries(snapshot.values).map(([key, after]) => ({ key, before: storage.getItem(key), after })).filter(entry => entry.before !== entry.after);
}
function checkedSet(storage: RecoveryStorage, key: string, value: string | null) {
  if (value === null) storage.removeItem(key); else storage.setItem(key, value);
  if (storage.getItem(key) !== value) throw new Error("本机存储写入未通过核对，恢复日志已保留。");
}
function parseJournal(raw: string): Journal {
  if (size(raw) > MAX_BYTES * 3) throw new Error("恢复日志过大，未载入工作区。");
  const value = JSON.parse(raw) as Journal;
  if (!value || value.version !== 1 || !["prepared", "committed"].includes(value.state) || !Array.isArray(value.entries) || value.entries.length > 1500 ||
    value.entries.some(entry => !entry || !recoveryKey(entry.key) || entry.after !== null && typeof entry.after !== "string" || entry.before !== null && typeof entry.before !== "string") ||
    new Set(value.entries.map(entry => entry.key)).size !== value.entries.length)
    throw new Error("恢复日志损坏，请保留备份；工作区未启动。");
  return value;
}
/** Called before editors mount. Incomplete imports roll back, committed imports survive cleanup failure. */
export function recoverLegacyImport(storage: RecoveryStorage): void {
  const raw = storage.getItem(RECOVERY_JOURNAL);
  if (raw === null) return;
  const journal = parseJournal(raw);
  if (journal.state === "prepared") {
    for (const entry of journal.entries) {
      const current = storage.getItem(entry.key);
      if (current !== entry.before && current !== entry.after) throw new Error("其他窗口修改了恢复中的记录；未覆盖对方数据，请保留备份核对。");
    }
    for (const entry of [...journal.entries].reverse()) {
      if (storage.getItem(RECOVERY_JOURNAL) !== raw) throw new Error("恢复日志已被其他窗口修改。");
      const current = storage.getItem(entry.key);
      if (current !== entry.before && current !== entry.after) throw new Error("回退时记录再次变化，恢复日志已保留。");
      checkedSet(storage, entry.key, entry.before);
    }
  }
  if (storage.getItem(RECOVERY_JOURNAL) !== raw) throw new Error("恢复日志已被其他窗口修改。");
  checkedSet(storage, RECOVERY_JOURNAL, null);
}
/** A reviewed plan is mandatory. Call in the standalone recovery page, with other clients closed. */
export function importLegacySnapshot(entries: RecoveryEntry[], storage: RecoveryStorage): void {
  applyReviewedEntries(entries, storage, true);
}
export function restoreLegacyBackup(storage: RecoveryStorage): void {
  const raw = storage.getItem(RECOVERY_BACKUP);
  if (raw === null) throw new Error("没有导入前备份。");
  const original = parseJournal(raw);
  const inverse = original.entries.flatMap(entry => {
    const current = storage.getItem(entry.key);
    if (current === entry.before) return [];
    if (current !== entry.after) throw new Error("导入后已有新编辑，未覆盖当前数据。请先导出并核对。");
    return [{ key: entry.key, before: entry.after, after: entry.before }];
  });
  applyReviewedEntries(inverse, storage, false);
}
function applyReviewedEntries(entries: RecoveryEntry[], storage: RecoveryStorage, createBackup: boolean): void {
  if (!entries.length) return;
  if (storage.getItem(RECOVERY_JOURNAL) !== null) throw new Error("上次恢复尚未核对，请先重试回退。");
  const prepared: Journal = { version: 1, state: "prepared", entries };
  const raw = JSON.stringify(prepared); parseJournal(raw);
  const assertCurrent = (written: number) => {
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      if (storage.getItem(entry.key) !== (i < written ? entry.after : entry.before)) throw new Error("预检后数据已变化，未继续导入；请关闭其他窗口并重新预检。");
    }
  };
  assertCurrent(0);
  // Keep the previous backup until the user downloads it; never silently replace it.
  if (createBackup) {
    if (storage.getItem(RECOVERY_BACKUP) !== null) throw new Error("上一次导入备份仍在；请先下载并清理该备份，再进行下一次导入。");
    checkedSet(storage, RECOVERY_BACKUP, raw);
  }
  checkedSet(storage, RECOVERY_JOURNAL, raw);
  try {
    for (let i = 0; i < entries.length; i++) {
      assertCurrent(i);
      if (storage.getItem(RECOVERY_JOURNAL) !== raw) throw new Error("恢复日志已被其他窗口修改。");
      checkedSet(storage, entries[i]!.key, entries[i]!.after);
    }
    assertCurrent(entries.length);
    checkedSet(storage, RECOVERY_JOURNAL, JSON.stringify({ ...prepared, state: "committed" }));
  } catch (error) {
    // If rollback itself fails, the journal blocks normal startup until repaired.
    recoverLegacyImport(storage);
    throw error;
  }
  recoverLegacyImport(storage);
}
