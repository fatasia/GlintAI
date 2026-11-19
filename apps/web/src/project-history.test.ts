import { describe, expect, it, vi } from "vitest";
import { type SceneScriptProject } from "@glintai/scenescript";
import { parseEditorProject } from "./editor-model";
import { prepareGitProjectRegistration, readSavedProjects, readSavedProjectsStrict, removeProject, saveProject, type SavedProject } from "./project-history";

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

describe("project history", () => {
  it("keeps the newest project first and caps history", () => {
    const storage = memoryStorage();
    for (let index = 0; index < 22; index++) saveProject({ id: String(index), name: `P${index}`, mode: "source", text: "x", template: "explainer", theme: "glint-dark", aspect: "16:9" }, storage);
    const projects = readSavedProjects(storage);
    expect(projects).toHaveLength(20);
    expect(projects[0]?.id).toBe("21");
  });

  it("updates an existing project instead of duplicating it", () => {
    const storage = memoryStorage();
    saveProject({ id: "a", name: "old", mode: "idea", text: "one", template: "explainer", theme: "glint-dark", aspect: "1:1" }, storage);
    saveProject({ id: "a", name: "new", mode: "idea", text: "two", template: "explainer", theme: "glint-dark", aspect: "1:1" }, storage);
    expect(readSavedProjects(storage)).toHaveLength(1);
    expect(readSavedProjects(storage)[0]?.name).toBe("new");
  });

  it("removes a project", () => {
    const storage = memoryStorage();
    saveProject({ id: "a", name: "A", mode: "source", text: "x", template: "explainer", theme: "glint-dark", aspect: "16:9" }, storage);
    removeProject("a", storage);
    expect(readSavedProjects(storage)).toEqual([]);
  });
});

const context = { mode: "source" as const, text: "工程来源", template: "explainer", theme: "glint-dark", evidence: "git:abc123" };
const project = () => parseEditorProject({
  schemaVersion: 1, id: "git-project", title: "Git 工程", aspect: "16:9", knowledgeSources: [],
  scenes: [{ id: "scene-a", kind: "title", title: "标题", narration: { text: "旁白" } }],
});
const saved = (id = "git-project", embedded?: SceneScriptProject): SavedProject => ({
  id, name: "旧名称", ...context, aspect: "1:1", updatedAt: 123,
  ...(embedded ? { project: embedded } : {}),
});

function trackedStorage(raw: string | null = null) {
  const storage = memoryStorage();
  if (raw !== null) storage.setItem("glint.projects", raw);
  return { getItem: vi.fn(storage.getItem), setItem: vi.fn(storage.setItem) };
}

const invalidLists = [
  { label: "损坏 JSON", raw: "{", error: /JSON.*损坏/ },
  { label: "非数组对象", raw: "{}", error: /数组/ },
  { label: "JSON null", raw: "null", error: /数组/ },
  { label: "空条目", raw: "[null]", error: /非法条目/ },
  { label: "缺少字段", raw: JSON.stringify([{ id: "incomplete" }]), error: /非法条目/ },
  { label: "非法模式", raw: JSON.stringify([{ ...saved(), mode: "invalid" }]), error: /非法条目/ },
  { label: "非法嵌入工程", raw: JSON.stringify([{ ...saved(), project: { id: "broken" } }]), error: /非法条目/ },
  { label: "空嵌入工程", raw: JSON.stringify([{ ...saved(), project: null }]), error: /非法条目/ },
  { label: "非法凭据", raw: JSON.stringify([{ ...saved(), evidence: 42 }]), error: /非法条目/ },
  { label: "多余第 21 项", raw: JSON.stringify(Array.from({ length: 21 }, (_, index) => saved(`p-${index}`))), error: /超过 20/ },
  { label: "重复列表编号", raw: JSON.stringify([saved(), saved()]), error: /重复列表编号/ },
];

describe("严格读取作品列表", () => {
  it("缺少存储项时返回空数组，且只读取目标键", () => {
    const storage = trackedStorage();
    expect(readSavedProjectsStrict(storage)).toEqual([]);
    expect(storage.getItem.mock.calls).toEqual([["glint.projects"]]);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("完整保留合法条目、顺序、旧式无工程条目及额外字段", () => {
    const items = [{ ...saved("alias", project()), extra: "保留" }, saved("legacy")];
    const storage = trackedStorage(JSON.stringify(items));
    expect(readSavedProjectsStrict(storage)).toEqual(items);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it.each(invalidLists)("拒绝 $label，不清洗原始数据", ({ raw, error }) => {
    const storage = trackedStorage(raw);
    expect(() => readSavedProjectsStrict(storage)).toThrow(error);
    expect(storage.getItem("glint.projects")).toBe(raw);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("读取失败时给出中文错误而非返回空列表", () => {
    expect(() => readSavedProjectsStrict({ getItem() { throw new Error("denied"); } })).toThrow(/无法读取本机作品列表/);
  });
});

describe("Git 工程登记准备与提交", () => {
  it("缺项时准备不写入，提交新增工程且无需 length/key 扫描", () => {
    const storage = trackedStorage();
    Object.defineProperties(storage, {
      length: { get() { throw new Error("不应扫描 length"); } },
      key: { get() { throw new Error("不应扫描 key"); } },
    });
    const input = project(), before = Date.now();
    const registration = prepareGitProjectRegistration(input, context, storage);
    expect(registration.existing).toBeNull();
    expect(registration.requiresConfirmation).toBe(false);
    expect(storage.getItem).toHaveBeenCalledTimes(1);
    expect(storage.setItem).not.toHaveBeenCalled();
    const result = registration.commit();
    expect(result).toMatchObject({ ...context, id: input.id, name: input.title, aspect: input.aspect, project: input });
    expect(result.updatedAt).toBeGreaterThanOrEqual(before);
    expect(result.updatedAt).toBeLessThanOrEqual(Date.now());
    expect(storage.getItem).toHaveBeenCalledTimes(3);
    expect(storage.getItem.mock.calls.every(([key]) => key === "glint.projects")).toBe(true);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(readSavedProjectsStrict(storage)).toEqual([result]);
  });

  it("严格解析捕获的同一份 raw，不二次读取不同快照", () => {
    const storage = trackedStorage("[]");
    storage.getItem.mockReturnValueOnce("[]").mockReturnValue("{}");
    const registration = prepareGitProjectRegistration(project(), context, storage);
    expect(storage.getItem).toHaveBeenCalledTimes(1);
    expect(() => registration.commit()).toThrow(/其他操作修改/);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("相同 canonical 快照幂等，不改上下文、时间及原始字节", () => {
    const input = project();
    const reordered = Object.fromEntries(Object.entries(input).reverse()) as SceneScriptProject;
    const entry = saved("list-alias", reordered);
    const raw = JSON.stringify([entry], null, 2), storage = trackedStorage(raw);
    const registration = prepareGitProjectRegistration(input, { ...context, text: "新上下文" }, storage);
    expect(registration.existing).toEqual(entry);
    expect(registration.requiresConfirmation).toBe(false);
    expect(registration.commit()).toBe(registration.existing);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.getItem("glint.projects")).toBe(raw);
  });

  it("别名工程的不同快照仅显式 commit 后更新，并保留列表别名及其他条目", () => {
    const old = project(), updated = { ...old, title: "更新快照", aspect: "1:1" as const };
    const entries = [saved("before"), saved("list-alias", old), saved("after")];
    const raw = JSON.stringify(entries), storage = trackedStorage(raw);
    const registration = prepareGitProjectRegistration(updated, { ...context, mode: "idea", text: "新来源", evidence: undefined }, storage);
    expect(registration.existing).toEqual(entries[1]);
    expect(registration.requiresConfirmation).toBe(true);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.getItem("glint.projects")).toBe(raw);
    const result = registration.commit();
    expect(result).toMatchObject({ id: "list-alias", name: updated.title, aspect: updated.aspect, project: updated, mode: "idea", text: "新来源" });
    expect(result).not.toHaveProperty("evidence");
    expect(readSavedProjectsStrict(storage)).toEqual([entries[0], result, entries[2]]);
  });

  it("同列表编号的旧式缺工程条目需要确认，提交时补入工程", () => {
    const entry = saved(), storage = trackedStorage(JSON.stringify([entry]));
    const registration = prepareGitProjectRegistration(project(), context, storage);
    expect(registration.existing).toEqual(entry);
    expect(registration.requiresConfirmation).toBe(true);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(registration.commit().project).toEqual(project());
  });

  it.each([
    { label: "两个嵌入工程相同", items: [saved("a", project()), saved("b", project())] },
    { label: "列表编号与另一条嵌入编号匹配", items: [saved(), saved("alias", project())] },
  ])("拒绝歧义：$label", ({ items }) => {
    const raw = JSON.stringify(items), storage = trackedStorage(raw);
    expect(() => prepareGitProjectRegistration(project(), context, storage)).toThrow(/歧义/);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.getItem("glint.projects")).toBe(raw);
  });

  it("列表编号相同但嵌入另一工程时拒绝覆盖", () => {
    const raw = JSON.stringify([saved("git-project", { ...project(), id: "other-project" })]);
    const storage = trackedStorage(raw);
    expect(() => prepareGitProjectRegistration(project(), context, storage)).toThrow(/编号.*冲突/);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.getItem("glint.projects")).toBe(raw);
  });

  it.each(invalidLists)("登记拒绝 $label，不借机清洗或截断", ({ raw, error }) => {
    const storage = trackedStorage(raw);
    expect(() => prepareGitProjectRegistration(project(), context, storage)).toThrow(error);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.getItem("glint.projects")).toBe(raw);
  });

  it("20 项已满时拒绝新增并逐字节保留原列表", () => {
    const raw = JSON.stringify(Array.from({ length: 20 }, (_, index) => saved(`p-${index}`)), null, 2);
    const storage = trackedStorage(raw);
    expect(readSavedProjectsStrict(storage)).toHaveLength(20);
    expect(() => prepareGitProjectRegistration(project(), context, storage)).toThrow(/已满 20/);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.getItem("glint.projects")).toBe(raw);
  });

  it("20 项已满仍可更新已有别名工程，不驱逐任何条目", () => {
    const items = Array.from({ length: 19 }, (_, index) => saved(`p-${index}`));
    const storage = trackedStorage(JSON.stringify([...items, saved("alias", project())]));
    const registration = prepareGitProjectRegistration({ ...project(), title: "已更新" }, context, storage);
    expect(registration.requiresConfirmation).toBe(true);
    const result = registration.commit();
    expect(readSavedProjectsStrict(storage)).toEqual([...items, result]);
    expect(result.id).toBe("alias");
  });

  it("满额列表的相同快照仍幂等", () => {
    const storage = trackedStorage(JSON.stringify([saved("alias", project()), ...Array.from({ length: 19 }, (_, index) => saved(`p-${index}`))]));
    const registration = prepareGitProjectRegistration(project(), context, storage);
    expect(registration.requiresConfirmation).toBe(false);
    expect(registration.commit()).toBe(registration.existing);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it.each([
    { mode: "invalid" }, { text: 42 }, { template: null }, { theme: false }, { evidence: 123 },
  ])("拒绝非法 context：%j", invalid => {
    const storage = trackedStorage();
    expect(() => prepareGitProjectRegistration(project(), { ...context, ...invalid } as unknown as typeof context, storage)).toThrow(/上下文无效/);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("相同快照也不能绕过 context 验证", () => {
    const storage = trackedStorage(JSON.stringify([saved("alias", project())]));
    expect(() => prepareGitProjectRegistration(project(), { ...context, mode: "bad" } as unknown as typeof context, storage)).toThrow(/上下文无效/);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("拒绝非法新工程及空旁白，不写入", () => {
    const storage = trackedStorage();
    expect(() => prepareGitProjectRegistration({ ...project(), aspect: "invalid" } as unknown as SceneScriptProject, context, storage)).toThrow(/工程数据无效/);
    const input = project();
    input.scenes[0]!.narration.text = "   ";
    expect(() => prepareGitProjectRegistration(input, context, storage)).toThrow(/工程数据无效/);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("quota 抛错时中文报错，不自动回滚或重试", () => {
    const raw = JSON.stringify([saved("other")]), storage = trackedStorage(raw);
    storage.setItem.mockImplementation(() => { throw new Error("QuotaExceededError"); });
    const registration = prepareGitProjectRegistration(project(), context, storage);
    expect(() => registration.commit()).toThrow(/写入失败/);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(storage.getItem("glint.projects")).toBe(raw);
  });

  it("silent drop 通过写后回读发现，不宣告成功", () => {
    const storage = trackedStorage("[]");
    storage.setItem.mockImplementation(() => {});
    const registration = prepareGitProjectRegistration(project(), context, storage);
    expect(() => registration.commit()).toThrow(/核对失败/);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(storage.getItem("glint.projects")).toBe("[]");
  });

  it("写后遇到 foreign 内容只报错，不回滚覆盖", () => {
    const storage = trackedStorage("[]"), foreign = JSON.stringify([saved("foreign")]);
    const write = storage.setItem.getMockImplementation()!;
    storage.setItem.mockImplementation((key) => write(key, foreign));
    const registration = prepareGitProjectRegistration(project(), context, storage);
    expect(() => registration.commit()).toThrow(/核对失败/);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(storage.getItem("glint.projects")).toBe(foreign);
  });

  it.each([
    { label: "新增 foreign 条目", initial: "[]", changed: JSON.stringify([saved("foreign")]) },
    { label: "仅原始空白改变", initial: "[]", changed: "[ ]" },
    { label: "缺项变为空列表", initial: null, changed: "[]" },
    { label: "原列表被删除", initial: "[]", changed: null },
  ])("baseline 完全比较：$label 时拒绝提交", ({ initial, changed }) => {
    const storage = trackedStorage(initial);
    const registration = prepareGitProjectRegistration(project(), context, storage);
    storage.getItem.mockReturnValue(changed);
    expect(() => registration.commit()).toThrow(/其他操作修改/);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.getItem("glint.projects")).toBe(changed);
  });

  it("幂等提交也先检查 baseline，不返回过期绑定", () => {
    const storage = trackedStorage(JSON.stringify([saved("alias", project())]));
    const registration = prepareGitProjectRegistration(project(), context, storage);
    storage.getItem.mockReturnValue("[]");
    expect(() => registration.commit()).toThrow(/其他操作修改/);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("登记初次读取失败时提供中文错误", () => {
    const storage = trackedStorage();
    storage.getItem.mockImplementation(() => { throw new Error("denied"); });
    expect(() => prepareGitProjectRegistration(project(), context, storage)).toThrow(/无法读取/);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("提交前读取失败不写入", () => {
    const storage = trackedStorage();
    const registration = prepareGitProjectRegistration(project(), context, storage);
    storage.getItem.mockImplementation(() => { throw new Error("denied"); });
    expect(() => registration.commit()).toThrow(/无法读取/);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("写后回读失败时不回滚或重写", () => {
    const storage = trackedStorage();
    const registration = prepareGitProjectRegistration(project(), context, storage);
    storage.getItem.mockImplementationOnce(() => null).mockImplementationOnce(() => { throw new Error("denied"); });
    expect(() => registration.commit()).toThrow(/无法回读/);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
  });
});
