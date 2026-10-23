import { parseImportedPack, type ImportedCreationPack } from "@glintai/composer/imported-packs";
const KEY = "glint.creation-packs.imported.v1";
export const IMPORTED_PACKS_CHANGED = "glint:creation-packs-changed";
function notifyChange() { if (typeof window !== "undefined") window.dispatchEvent(new Event(IMPORTED_PACKS_CHANGED)); }
const MAX_PACKS = 12;
const MAX_BYTES = 1_000_000;
type StorageReader = Pick<Storage, "getItem">;
type StorageWriter = StorageReader & Pick<Storage, "setItem">;

export function readImportedPacks(storage: StorageReader = localStorage): ImportedCreationPack[] {
  const raw = storage.getItem(KEY);
  if (!raw) return [];
  if (raw.length > MAX_BYTES) throw new Error("本机创作包存储超出安全上限，请先导出项目备份。");
  const values: unknown = JSON.parse(raw);
  if (!Array.isArray(values) || values.length > MAX_PACKS) throw new Error("本机创作包列表损坏，请先备份后再重置。");
  const packs = values.map(parseImportedPack);
  if (new Set(packs.map(pack => pack.id)).size !== packs.length) throw new Error("本机创作包存在重复 ID，请检查导入版本。");
  return packs;
}
export function installImportedPack(value: unknown, storage: StorageWriter = localStorage): ImportedCreationPack[] {
  const pack = parseImportedPack(value), current = readImportedPacks(storage);
  if (current.some(item => item.id === pack.id)) throw new Error("该创作包已存在。为避免静默更新，请先移除旧包；已创建的工程不受影响。");
  if (current.length >= MAX_PACKS) throw new Error(`最多保留 ${MAX_PACKS} 个导入包，请先移除不再使用的包。`);
  const next = [...current, pack], serialized = JSON.stringify(next);
  if (serialized.length > MAX_BYTES) throw new Error("本机存储上限不足，请先移除不再使用的创作包。");
  storage.setItem(KEY, serialized); notifyChange(); return next;
}
export function removeImportedPack(id: string, storage: StorageWriter = localStorage): ImportedCreationPack[] {
  const next = readImportedPacks(storage).filter(pack => pack.id !== id);
  storage.setItem(KEY, JSON.stringify(next)); notifyChange(); return next;
}
/** Explicit upgrade: only replaces an existing id, never silently installs a new one. */
export function replaceImportedPack(value: unknown, storage: StorageWriter = localStorage): ImportedCreationPack[] {
  const pack = parseImportedPack(value), current = readImportedPacks(storage);
  if (!current.some(item => item.id === pack.id)) throw new Error("要更新的创作包不在本机创作库，请按新包添加。");
  const next = current.map(item => item.id === pack.id ? pack : item), serialized = JSON.stringify(next);
  if (serialized.length > MAX_BYTES) throw new Error("本机存储上限不足，请先移除不再使用的创作包。");
  storage.setItem(KEY, serialized); notifyChange(); return next;
}
