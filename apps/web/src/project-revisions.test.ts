import { beforeEach, describe, expect, it } from "vitest";
import type { SavedProject } from "./project-history";
import { branchRevision, clearRevisions, readRevisions, recordRevision, restoreRevision, revisionDelta, revisionKey } from "./project-revisions";

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

const snapshot = (id = "work-1", text = "第一版"): SavedProject => ({
  id, name: "咖啡短片", mode: "source", text, template: "explainer",
  theme: "glint-dark", aspect: "16:9", updatedAt: 1,
  project: { schemaVersion: 1, id, title: "咖啡短片", aspect: "16:9", knowledgeSources: [], scenes: [
    { id: "one", kind: "title", title: "开场", narration: { text: "第一句" } },
  ] } as SavedProject["project"],
});

describe("durable project revisions", () => {
  let storage: MemoryStorage;
  beforeEach(() => { storage = new MemoryStorage(); });

  it("records a labelled snapshot and deduplicates an identical consecutive save", () => {
    const first = recordRevision(snapshot(), { label: "手动保存", reason: "manual", now: 10, storage });
    expect(first).not.toBeNull();
    const again = recordRevision(snapshot(), { label: "手动保存", reason: "manual", now: 20, storage });
    expect(again?.id).toBe(first?.id);
    expect(readRevisions("work-1", storage)).toHaveLength(1);
    recordRevision(snapshot("work-1", "第二版"), { label: "生成分镜", reason: "generated", now: 30, storage });
    const list = readRevisions("work-1", storage);
    expect(list).toHaveLength(2);
    expect(list[0]?.label).toBe("生成分镜");
  });

  it("caps history and ignores corrupt storage", () => {
    for (let index = 0; index < 45; index++) recordRevision(snapshot("work-1", `版本 ${index}`), { label: `v${index}`, reason: "manual", now: index, storage });
    expect(readRevisions("work-1", storage)).toHaveLength(40);
    storage.setItem(revisionKey("work-1"), "{not json");
    expect(readRevisions("work-1", storage)).toEqual([]);
  });

  it("restores a copy without mutating the stored revision", () => {
    const revision = recordRevision(snapshot(), { label: "手动保存", reason: "manual", storage })!;
    const restored = restoreRevision(revision, 99);
    restored.text = "改过的";
    expect(revision.snapshot.text).toBe("第一版");
    expect(restored.updatedAt).toBe(99);
    expect(restored.id).toBe("work-1");
  });

  it("forks a revision into a fresh work id and leaves the source untouched", () => {
    const revision = recordRevision(snapshot(), { label: "手动保存", reason: "manual", storage })!;
    const branch = branchRevision(revision, "咖啡短片 · 另一条线", 50);
    expect(branch.id).not.toBe("work-1");
    expect(branch.name).toBe("咖啡短片 · 另一条线");
    expect(branch.project?.id).toBe(branch.id);
    expect(branch.updatedAt).toBe(50);
    expect(revision.snapshot.project?.id).toBe("work-1");
  });

  it("clears history per work and summarizes the delta", () => {
    const revision = recordRevision(snapshot(), { label: "首版", reason: "manual", storage })!;
    const delta = revisionDelta(revision, { ...snapshot(), text: "新资料", theme: "bold-poster" });
    expect(delta.changed).toEqual(["资料", "风格"]);
    clearRevisions("work-1", storage);
    expect(readRevisions("work-1", storage)).toEqual([]);
  });
});
