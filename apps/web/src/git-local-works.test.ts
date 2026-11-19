// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseProject } from "@glintai/scenescript";
import { findLocalGitWorks, readLocalGitWork, rememberLocalGitSource } from "./git-local-works";
import { gitProjectKey, prepareGitStorage } from "./project-git-storage";

afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });
const context = { mode: "source" as const, text: "此副本的原资料", template: "explainer", theme: "glint-dark", evidence: "此副本的证据" };
const project = (id = "local-copy", title = "本机副本") => parseProject({ schemaVersion: 1, id, title, aspect: "16:9", knowledgeSources: [], scenes: [{ id: "one", kind: "title", title, narration: { text: "保留旁白" } }] });
const sourceKey = (id = "local-copy") => `glint:git-source.v1:${id}`;
function persist(id = "local-copy", title = "本机副本") {
  const value = project(id, title), tx = prepareGitStorage(id, undefined, undefined, localStorage, true, value);
  tx.write(); tx.commit(); tx.finish(); return value;
}
const snapshot = () => Object.fromEntries(Object.keys(localStorage).sort().map(key => [key, localStorage.getItem(key)]));
const saved = (value = project(), id = value.id) => ({ id, name: value.title, project: value, ...context, aspect: value.aspect, updatedAt: 1 });

describe("独立本机 Git 工程发现与原资料记录", () => {
  it("切到无关工程并重启后可发现多个副本；发现和读取不写工作区或作品列表", () => {
    const first = persist(), second = persist("second-copy", "第二副本");
    rememberLocalGitSource(first, context);
    rememberLocalGitSource(second, { ...context, text: "第二份资料" });
    localStorage.setItem("glint.workspace", JSON.stringify({ project: project("unrelated"), text: "不可混入" }));
    const before = snapshot(), found = findLocalGitWorks();
    expect(found.works.map(item => item.id)).toEqual([first.id, second.id]);
    expect(readLocalGitWork(first.id).context).toEqual(context);
    expect(readLocalGitWork(second.id).context?.text).toBe("第二份资料");
    expect(snapshot()).toEqual(before);
  });
  it("按嵌入工程编号识别已登记别名，但不隐藏内容不同或多义入口", () => {
    const value = persist();
    localStorage.setItem("glint.projects", JSON.stringify([saved(value, "old-alias")]));
    expect(findLocalGitWorks().works).toEqual([]);
    localStorage.setItem("glint.projects", JSON.stringify([saved({ ...value, title: "较新的手动版本" }, "old-alias")]));
    expect(findLocalGitWorks().works).toHaveLength(1);
    localStorage.setItem("glint.projects", JSON.stringify([saved(value, "old-alias"), saved(value, "another-alias")]));
    expect(findLocalGitWorks().works).toHaveLength(1);
  });
  it.each(["[]", "{", JSON.stringify(Array.from({ length: 20 }, (_, n) => saved(project(`full-${n}`))))])("删除、损坏或满额列表不抹去可发现副本：%s", raw => {
    const value = persist(); localStorage.setItem("glint.projects", raw); const before = snapshot();
    const found = findLocalGitWorks(); expect(found.works[0]?.id).toBe(value.id);
    if (raw === "{") expect(found.notice).toContain("损坏");
    expect(snapshot()).toEqual(before);
  });
  it("未完成恢复与损坏主快照逐条可见，不回放 prepared 日志或误报为可打开", () => {
    const value = persist();
    const tx = prepareGitStorage("prepared-copy", undefined, undefined, localStorage, true, project("prepared-copy")); tx.write();
    localStorage.setItem(gitProjectKey("broken"), "{");
    const before = snapshot(), found = findLocalGitWorks();
    expect(found.works.find(item => item.id === "prepared-copy")?.error).toContain("恢复日志");
    expect(found.works.find(item => item.id === value.id)?.project).toBeUndefined();
    expect(snapshot()).toEqual(before);
    localStorage.removeItem("glint:git-active-restore.v1");
    expect(findLocalGitWorks().works.find(item => item.id === "broken")?.error).toContain("无法安全读取");
  });
  it("缺少原资料或记录属于旧快照时不借用当前工作区资料", () => {
    const value = persist(); expect(readLocalGitWork(value.id).context).toBeUndefined();
    rememberLocalGitSource(value, context);
    localStorage.setItem(gitProjectKey(value.id), JSON.stringify({ ...value, title: "新的主快照" }));
    const found = readLocalGitWork(value.id);
    expect(found.context).toBeUndefined(); expect(found.warning).toContain("另一个主快照");
    expect(() => rememberLocalGitSource(value, context)).toThrow("已变化");
  });
  it("同一主快照重启时保留已记录原资料，不以外来工作区文字替换", () => {
    const value = persist(); rememberLocalGitSource(value, context); const raw = localStorage.getItem(sourceKey());
    rememberLocalGitSource(value, { ...context, text: "其他工程资料" });
    expect(localStorage.getItem(sourceKey())).toBe(raw);
  });
  it.each(["{", JSON.stringify({ version: 1, project: project("wrong-id"), context }), JSON.stringify({ version: 1, project: project(), context: { ...context, token: "not-a-secret" } })])("损坏或身份错误的原资料原样保留：%s", raw => {
    const value = persist(); localStorage.setItem(sourceKey(), raw);
    expect(readLocalGitWork(value.id)).toMatchObject({ context: undefined, warning: expect.stringContaining("无法读取") });
    expect(() => rememberLocalGitSource(value, context)).toThrow("无法读取");
    expect(localStorage.getItem(sourceKey())).toBe(raw);
  });
  it.each(["主快照", "原资料", "附件", "恢复日志"])("确认前后可复验%s变化", kind => {
    const value = persist(); rememberLocalGitSource(value, context); const found = readLocalGitWork(value.id);
    if (kind === "主快照") localStorage.setItem(gitProjectKey(value.id), JSON.stringify({ ...value, title: "外来修改" }));
    if (kind === "原资料") localStorage.setItem(sourceKey(), "{");
    if (kind === "附件") localStorage.setItem(`glint.project-designs.v1:${value.id}`, "{}");
    if (kind === "恢复日志") localStorage.setItem(`glint:git-restore.v1:${value.id}`, "{}");
    expect(() => found.assertCurrent()).toThrow();
  });
  it("静默丢写与配额异常不报告原资料保存成功，主快照不回退", () => {
    const value = persist(), before = localStorage.getItem(gitProjectKey(value.id)), write = Storage.prototype.setItem;
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, raw) { if (key !== sourceKey()) write.call(this, key, raw); });
    expect(() => rememberLocalGitSource(value, context)).toThrow("写入未确认");
    spy.mockImplementation(() => { throw new DOMException("quota", "QuotaExceededError"); });
    expect(() => rememberLocalGitSource(value, context)).toThrow("quota");
    expect(localStorage.getItem(gitProjectKey(value.id))).toBe(before);
  });
  it("非法编号只列出错误，不读取另一存储键；不扫描或导出认证配置", () => {
    localStorage.setItem(gitProjectKey("../../other"), "{}"); localStorage.setItem("unrelated.private-config", "unrelated");
    const read = vi.spyOn(Storage.prototype, "getItem"), found = findLocalGitWorks();
    expect(found.works).toMatchObject([{ id: "../../other", error: expect.stringContaining("编号无效") }]);
    expect(read.mock.calls.some(([key]) => key === "unrelated.private-config")).toBe(false);
    expect(() => readLocalGitWork("../../other")).toThrow("编号无效");
  });
});
