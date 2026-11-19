import { parseNleProject, type NleProject } from "@glintai/scenescript";
import type { EditOperation } from "@glintai/session";

function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(item => stableJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter(key => record[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

type RecordValue = Record<string, unknown>;
function jsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(jsonValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined).map(([key, child]) => [key, jsonValue(child)]));
  return value;
}
const hasIds = (items: unknown[]): items is Array<RecordValue & { id: string }> =>
  items.every(item => item && typeof item === "object" && typeof (item as RecordValue).id === "string");

/** Array indexes are resolved against the replayed document, never the original document. */
export function diffNleProjects(before: NleProject, after: NleProject): EditOperation[] {
  parseNleProject(before); parseNleProject(after);
  if (before.id !== after.id || before.schemaVersion !== after.schemaVersion) throw new Error("工程身份已变化，请重新打开工程后编辑。");
  const replay = structuredClone(before) as unknown as RecordValue;
  const operations: EditOperation[] = [];
  const emit = (raw: EditOperation) => {
    const operation = "value" in raw ? { ...raw, value: jsonValue(raw.value) } : raw;
    operations.push(operation);
    const path = operation.path;
    let parent: unknown = replay;
    for (const segment of path.slice(0, -1)) parent = (parent as RecordValue)[segment];
    const key = path[path.length - 1]!;
    if (operation.kind === "insert") {
      ((parent as RecordValue)[key] as unknown[]).splice(operation.index, 0, structuredClone(operation.value));
    } else if (operation.kind === "delete") {
      if (Array.isArray(parent)) parent.splice(Number(key), 1);
      else delete (parent as RecordValue)[key];
    } else if (operation.kind === "set") (parent as RecordValue)[key] = structuredClone(operation.value);
  };
  const walk = (a: unknown, b: unknown, path: string[]) => {
    if (stableJson(a) === stableJson(b)) return;
    if (Array.isArray(a) && Array.isArray(b) && hasIds(a) && hasIds(b)) {
      const wanted = new Set(b.map(item => item.id));
      for (let index = a.length - 1; index >= 0; index--) {
        if (!wanted.has(a[index]!.id)) emit({ kind: "delete", path: [...path, String(index)] });
      }
      for (const [index, item] of b.entries()) {
        const existing = a.findIndex(candidate => candidate.id === item.id);
        if (existing === -1) emit({ kind: "insert", path, index, value: item });
        else {
          if (existing !== index) {
            const value = structuredClone(a[existing]);
            emit({ kind: "delete", path: [...path, String(existing)] });
            emit({ kind: "insert", path, index, value });
          }
          walk(a[index], item, [...path, String(index)]);
        }
      }
      return;
    }
    if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) walk((a as RecordValue)[key], (b as RecordValue)[key], [...path, key]);
      return;
    }
    emit(b === undefined ? { kind: "delete", path } : { kind: "set", path, value: b });
  };
  walk(replay, after, []);
  if (stableJson(replay) !== stableJson(after)) throw new Error("工程差异无法安全重放，编辑未提交。请导出工程后重新打开。");
  return operations;
}
