import { mergeChapters, readChapters, withChapterWriteLock, writeChapters, type ChapterSnapshot } from "./ChaptersStore";

const MAX_PACKAGE_BYTES = 32 * 1024 * 1024;
type ChapterStorage = Pick<Storage, "getItem" | "setItem">;

/** Both operations must use the exact package bytes; preflight must have no side effects.
 * Publish must revalidate and be idempotent, including after an ambiguous failure. */
export interface PortableImportAdapter {
  preflight(serialized: string): Promise<ChapterSnapshot[]>;
  publish(serialized: string): Promise<ChapterSnapshot[]>;
}
export interface ImportPreview {
  readonly token: object;
  readonly chapters: ChapterSnapshot[];
}

type Pending = {
  serialized: string;
  base: string;
  chapters: ChapterSnapshot[];
  token: object;
};

/** Standalone orchestration only: no default backend, storage, UI, or network access. */
export function createPortableImportController(adapter: PortableImportAdapter, storage: ChapterStorage, lock: <T>(task: () => Promise<T> | T) => Promise<T> = withChapterWriteLock) {
  let pending: Pending | undefined;
  let busy = false;
  let generation = 0;

  const exclusive = async <T>(task: () => Promise<T>): Promise<T> => {
    if (busy) throw new Error("已有导入操作进行中，请等待完成。");
    busy = true;
    try { return await task(); } finally { busy = false; }
  };
  const current = () => JSON.stringify(readChapters(storage));
  const assertUnchanged = (base: string) => {
    if (current() !== base) throw new Error("本机章节已变化，请重新预检并确认；原包仍保留。");
  };
  const checked = (base: ChapterSnapshot[], incoming: ChapterSnapshot[]) => {
    if (!Array.isArray(incoming) || incoming.length === 0) throw new Error("迁移包没有可导入的章节。");
    const additions: ChapterSnapshot[] = [];
    for (const chapter of incoming) {
      const existing = base.find(item => item.project.id.normalize("NFC").toLowerCase() === chapter.project.id.normalize("NFC").toLowerCase());
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(chapter)) throw new Error(`章节工程 ID 冲突：${chapter.project.id}，未覆盖已有章节。`);
      } else additions.push(chapter);
    }
    const combined = mergeChapters(base, additions);
    // Parsing may normalize or discard fields; migration cannot silently lose them.
    if (JSON.stringify(combined.slice(base.length)) !== JSON.stringify(additions)) throw new Error("迁移章节无法完整保存，请检查快照格式。");
    return combined;
  };

  return {
    async preflight(serialized: string): Promise<ImportPreview> {
      return exclusive(async () => {
        if (pending) throw new Error("已有待处理的迁移包，请先完成或取消。");
        if (typeof serialized !== "string" || !serialized || new TextEncoder().encode(serialized).byteLength > MAX_PACKAGE_BYTES) throw new Error("迁移包为空或超过 32 MiB。");
        const version = generation;
        const base = readChapters(storage);
        const baseline = JSON.stringify(base);
        const incoming = await adapter.preflight(serialized);
        if (version !== generation) throw new Error("预检已取消。");
        assertUnchanged(baseline);
        checked(base, incoming);
        // Clone across the adapter and preview boundaries so confirmation covers exactly
        // the preflight result, not subsequently mutated objects.
        const chapters = structuredClone(incoming);
        const token = Object.freeze({});
        pending = { serialized, base: baseline, chapters, token };
        return { token, chapters: structuredClone(chapters) };
      });
    },
    async confirm(token: object): Promise<ChapterSnapshot[]> {
      return exclusive(() => lock(async () => {
        const item = pending;
        if (!item || token !== item.token) throw new Error("请先预检并明确确认当前迁移包。");
        assertUnchanged(item.base);
        // A previous publication may have been changed or removed after a failed save.
        // Every attempt revalidates the original package and its installed assets.
        const result = await adapter.publish(item.serialized);
        if (JSON.stringify(result) !== JSON.stringify(item.chapters)) throw new Error("发布结果与预检不一致；未写入章节，请保留原包并检查素材库。");
        // Other windows can modify the store while publication is in progress.
        assertUnchanged(item.base);
        const next = checked(readChapters(storage), item.chapters);
        try {
          const saved = writeChapters(next, storage);
          pending = undefined;
          return saved;
        } catch (error) {
          throw new Error("本机章节保存失败，原包和预检结果仍保留；可重试保存。", { cause: error });
        }
      }));
    },
    cancel(): void {
      if (busy) {
        // Only an in-flight preflight can be invalidated; publishing cannot safely be undone.
        if (pending) throw new Error("发布或保存进行中，无法取消；请等待结果。");
        generation++;
      } else {
        pending = undefined;
        generation++;
      }
    },
    hasPending(): boolean { return pending !== undefined; },
    /** The caller can save or re-preflight the original after an unrecoverable conflict. */
    retainedPackage(): string | undefined { return pending?.serialized; },
  };
}
