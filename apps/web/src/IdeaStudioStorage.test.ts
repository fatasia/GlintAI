import { describe, expect, it, vi } from "vitest";
import { recoverStudioWorkspace } from "./IdeaStudioStorage";

function memory(entries: Record<string, string> = {}) {
  const values = new Map(Object.entries(entries));
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}

describe("studio recovery loading boundary", () => {
  it("does not load the editor recovery chain for empty or ordinary saved workspaces", async () => {
    const load = vi.fn();
    expect(await recoverStudioWorkspace(memory(), load)).toBeNull();
    const workspace = { text: "保留草稿", project: { id: "saved" } };
    expect(await recoverStudioWorkspace(memory({ "glint.workspace": JSON.stringify(workspace) }), load)).toEqual(workspace);
    expect(load).not.toHaveBeenCalled();
  });

  it.each(["glint:git-active-restore.v1", "glint:git-restore.v1:saved"])("does not treat failed loading of %s as an empty workspace", async key => {
    const raw = JSON.stringify({ text: "不能丢失", project: { id: "saved" } });
    const storage = memory({ "glint.workspace": raw, [key]: "saved" });
    const failure = new Error("recovery chunk unavailable"), load = vi.fn().mockRejectedValue(failure);
    await expect(recoverStudioWorkspace(storage, load)).rejects.toBe(failure);
    expect(storage.getItem("glint.workspace")).toBe(raw);
    expect(storage.getItem(key)).toBe("saved");
    expect(load).toHaveBeenCalledOnce();
  });

  it("runs the actual recovery implementation before resolving an active journal", async () => {
    const storage = memory({ "glint:git-active-restore.v1": "INVALID!", "glint.workspace": "broken" });
    await expect(recoverStudioWorkspace(storage)).rejects.toThrow("恢复目标编号无效");
    expect(storage.getItem("glint.workspace")).toBe("broken");
  });

  it("keeps malformed ordinary workspace bytes and reports the read error without loading", async () => {
    const storage = memory({ "glint.workspace": "broken" }), load = vi.fn();
    await expect(recoverStudioWorkspace(storage, load)).rejects.toThrow("本机工作区无法读取");
    expect(load).not.toHaveBeenCalled(); expect(storage.getItem("glint.workspace")).toBe("broken");
  });
});
