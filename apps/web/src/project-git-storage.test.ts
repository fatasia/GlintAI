import {nleRecordKey,parseNleRecord,serializeNleRecord} from "./nle-project-library";
import {createNleSession} from "./nle-session";
import {parseNleProject} from "@glintai/scenescript";
import { describe, expect, it, vi } from "vitest";
import { parseProject, parseProjectWorkspace, type ProjectWorkspace, type SceneScriptProject } from "@glintai/scenescript";
import { assertGitStorageReady, captureProjectWorkspace, prepareGitStorage, readGitProject, readLocalGitVersion, recoverGitStorage, recoverGitWorkspace, sameGitProject, saveLocalWorkspace, type GitStorage } from "./project-git-storage";
import { designDocumentsKey } from "./design-artifacts";
import { BRAND_DRAFT_KEY, projectBrandKey, projectBrandRaw } from "./design-brand";
import { projectAssetsKey } from "./design-assets";
import { projectDocumentsKey, type ProjectDocuments } from "./script-documents";

const projectId = "storage-test";
const journalKey = (id = projectId) => `glint:git-restore.v1:${id}`;
const attachmentKeys = (id = projectId) => [projectDocumentsKey(id), designDocumentsKey(id), projectBrandKey(id), projectAssetsKey(id)];
function workspace(id = projectId, label = "恢复"): ProjectWorkspace {
  return { version: 1, projectId: id, designs: { version: 1, projectId: id, activeId: "design", documents: [{ id: "design", title: label, kind: "page", updatedAt: 1, activePageId: "page", pages: [{ id: "page", title: label, html: `<main>${label}</main>`, annotations: [{ id: "mark", text: label, x: 1, y: 2, createdAt: 0 }] }] }] },
    brand: { name: label, accent: "#abcdef", bg: "#000000", text: "#ffffff" }, assets: [{ name: "cover.png", url: "/assets/cover.png", bytes: 20 }] };
}
const documents = (id = projectId, label = "恢复"): ProjectDocuments => ({ version: 1, projectId: id, activeId: "script", documents: [{ id: "script", title: label, kind: "script", content: label, updatedAt: 1 }] });
function memory(seed: [string, string][] = []) {
  const data = new Map(seed);
  const storage: GitStorage = { getItem: vi.fn((key: string) => data.get(key) ?? null), setItem: vi.fn((key: string, value: string) => { data.set(key, value); }), removeItem: vi.fn((key: string) => { data.delete(key); }) };
  return { data, storage, snapshot: () => [...data.entries()].sort(([a], [b]) => a.localeCompare(b)) };
}
function seed(id = projectId, label = "原稿"): [string, string][] {
  const value = workspace(id, label);
  return [[projectDocumentsKey(id), JSON.stringify(documents(id, label))], [designDocumentsKey(id), JSON.stringify(value.designs)], [projectBrandKey(id), projectBrandRaw(value.brand!)], [projectAssetsKey(id), JSON.stringify(value.assets)]];
}
type Entry = { key: string; before: string | null; after: string | null };
const journal = (entries: Entry[]) => JSON.stringify({ version: 1, entries });
const projectKey = (id = projectId) => `glint:git-project.v1:${id}`;
const workspaceKey = "glint.workspace";
const activeRestoreKey = "glint:git-active-restore.v1";
const transactionKeys = (id = projectId) => [...attachmentKeys(id), projectKey(id), workspaceKey];
function project(id = projectId, title = "恢复"): SceneScriptProject {
  return parseProject({ schemaVersion: 1, id, title, aspect: "16:9", knowledgeSources: [], scenes: [{ id: "one", kind: "title", title, narration: { text: title, durationMs: 1000 } }] });
}
const studioWorkspace = (value = project(projectId, "原稿")) => ({ mode: "source", text: "保留原资料", template: "explainer", theme: "glint-dark", aspect: "16:9", project: value, evidence: "保留证据", extra: { preserved: true } });
function fullSeed(id = projectId): [string, string][] {
  return [...seed(id).map(([key, raw]): [string, string] => [key, key === projectAssetsKey(id) ? JSON.stringify([{ name: "before.png", url: "/assets/before.png", bytes: 10 }]) : raw]), [projectKey(id), JSON.stringify(project(id, "原稿"))], [workspaceKey, JSON.stringify(studioWorkspace(project(id, "原稿")))]];
}
const v2Journal = (entries: Entry[], state = "prepared") => JSON.stringify({ version: 2, state, entries });
function readJournal(store: ReturnType<typeof memory>, id = projectId) {
  return JSON.parse(store.data.get(journalKey(id))!) as { version: number; state: string; entries: Entry[] };
}
function expectActiveProject(store: ReturnType<typeof memory>, id = projectId) {
  const raw = store.data.get(activeRestoreKey);
  expect(raw).toBeTypeOf("string");
  // 指针的编码不是事务接口的一部分，但必须能独立定位工程。
  let value: unknown = raw;
  try { value = JSON.parse(raw!); } catch { /* 也允许直接保存工程编号。 */ }
  expect(typeof value === "string" ? value : (value as { projectId?: string }).projectId).toBe(id);
}
function expectedAfter(before: Map<string, string>, id = projectId): Map<string, string> {
  return new Map([...seed(id, "恢复"), [designDocumentsKey(id), JSON.stringify(parseProjectWorkspace(workspace(id), id).designs)], [projectKey(id), JSON.stringify(project(id))], [workspaceKey, JSON.stringify({ ...JSON.parse(before.get(workspaceKey) ?? "{}"), aspect: project(id).aspect, project: project(id) })]]);
}

it.each(["提交恢复", "中断回退"])("Git 完整恢复事务同时处理工程与有效画幅：%s", action => {
  const store = memory(fullSeed()), before = store.data.get(workspaceKey)!;
  const restored = parseProject({ ...project(), aspect: "9:16" });
  const tx = prepareGitStorage(projectId, undefined, undefined, store.storage, false, restored);
  tx.write();
  expect(JSON.parse(store.data.get(workspaceKey)!)).toEqual({ ...JSON.parse(before), aspect: "9:16", project: restored });
  if (action === "提交恢复") tx.commit();
  recoverGitWorkspace(store.storage);
  if (action === "提交恢复") expect(JSON.parse(store.data.get(workspaceKey)!)).toMatchObject({ aspect: "9:16", project: restored });
  else expect(store.data.get(workspaceKey)).toBe(before);
});

function pointReadMemory(values: [string, string][] = []) {
  const store = memory(values), before = store.snapshot();
  const key = vi.fn(() => { throw new Error("禁止枚举存储 key"); });
  const length = vi.fn(() => { throw new Error("禁止读取存储 length"); });
  Object.defineProperties(store.storage, { key: { value: key }, length: { get: length } });
  return { ...store, before, key, length };
}
function expectPointReads(store: ReturnType<typeof pointReadMemory>, keys: string[]) {
  expect(vi.mocked(store.storage.getItem).mock.calls).toEqual(keys.map(key => [key]));
  expect(store.storage.setItem).not.toHaveBeenCalled(); expect(store.storage.removeItem).not.toHaveBeenCalled();
  expect(store.key).not.toHaveBeenCalled(); expect(store.length).not.toHaveBeenCalled();
  expect(store.snapshot()).toEqual(store.before);
}

const readyError = "本机恢复日志待核对或清理；请先重试本机恢复，未打开旧作品快照。";
const projectReadError = "完整本机工程无法安全读取；请先导出备份，未降级打开旧作品。";
const activeValues = ["", projectId, "foreign", " ", "{", "null", "0"];
const pendingJournals = ["", "{", journal([{ key: projectDocumentsKey(projectId), before: null, after: "待恢复" }])];

describe("assertGitStorageReady 只读定点屏障", () => {
  it.each([undefined, projectId].flatMap(id => activeValues.map(active => ({ id, active }))))("全局 active=$active 存在即拒绝，目标=$id，不解析或清理", ({ id, active }) => {
    const store = pointReadMemory([...fullSeed(), [activeRestoreKey, active]]);
    expect(() => assertGitStorageReady(id, store.storage)).toThrow(readyError);
    expectPointReads(store, [activeRestoreKey]);
  });
  it.each(pendingJournals.map((raw, index) => ({ raw, index })))("目标 journal 存在即拒绝，包括空字符串与损坏内容：$index", ({ raw }) => {
    const store = pointReadMemory([...fullSeed(), [journalKey(), raw]]);
    expect(() => assertGitStorageReady(projectId, store.storage)).toThrow(readyError);
    expectPointReads(store, [activeRestoreKey, journalKey()]);
  });
  it.each([undefined, projectId])("无全局 active 时只检查指定目标=%s，不扫描其他工程 journal", id => {
    const store = pointReadMemory([...fullSeed(), [journalKey("foreign"), "{"], [projectKey("foreign"), "损坏工程"]]);
    expect(assertGitStorageReady(id, store.storage)).toBeUndefined();
    expectPointReads(store, id === undefined ? [activeRestoreKey] : [activeRestoreKey, journalKey()]);
  });
  it.each([activeRestoreKey, journalKey()])("读取 %s 抛错必须原样传播，不伪装为已就绪", failedKey => {
    const store = pointReadMemory(fullSeed()), failure = new Error("读取被拒绝");
    vi.mocked(store.storage.getItem).mockImplementation(key => { if (key === failedKey) throw failure; return store.data.get(key) ?? null; });
    let caught: unknown; try { assertGitStorageReady(projectId, store.storage); } catch (cause) { caught = cause; }
    expect(caught).toBe(failure);
    expectPointReads(store, failedKey === activeRestoreKey ? [activeRestoreKey] : [activeRestoreKey, journalKey()]);
  });
});

describe("readGitProject 严格指定工程读取", () => {
  const reads = [activeRestoreKey, journalKey(), projectKey()];
  it.each(activeValues)("全局 active=%j 存在时拒绝，不读取工程或降级到旧快照", active => {
    const store = pointReadMemory([...fullSeed(), [activeRestoreKey, active]]);
    expect(() => readGitProject(projectId, store.storage)).toThrow(readyError);
    expectPointReads(store, [activeRestoreKey]);
  });
  it.each(pendingJournals.map((raw, index) => ({ raw, index })))("目标 journal=$index 存在时拒绝，不读取工程或恢复日志", ({ raw }) => {
    const store = pointReadMemory([...fullSeed(), [journalKey(), raw]]);
    expect(() => readGitProject(projectId, store.storage)).toThrow(readyError);
    expectPointReads(store, [activeRestoreKey, journalKey()]);
  });
  it("指定工程缺失返回 null，不读取有效全局 workspace、其他工程或其 journal", () => {
    const store = pointReadMemory([...seed(), [workspaceKey, JSON.stringify(studioWorkspace())], [projectKey("foreign"), JSON.stringify(project("foreign"))], [journalKey("foreign"), "{"]]);
    expect(readGitProject(projectId, store.storage)).toBeNull();
    expectPointReads(store, reads);
  });
  it("合法工程经过解析后返回，只读取目标 key，无关损坏资料和其他 journal 不影响结果", () => {
    const expected = project(), raw = { ...expected, ignored: "解析时应剔除" };
    expect(parseProject(raw)).toEqual(expected); expect(raw).not.toEqual(expected);
    const store = pointReadMemory([...seed(), [projectKey(), JSON.stringify(raw)], [workspaceKey, "{"], [projectKey("foreign"), "{"], [journalKey("foreign"), "{"]]);
    expect(readGitProject(projectId, store.storage)).toEqual(expected);
    expectPointReads(store, reads);
  });
  it.each([
    ["空字符串", ""],
    ["坏 JSON", "{"],
    ["错误工程身份", JSON.stringify(project("foreign"))],
    ["JSON null", "null"],
    ["数组", "[]"],
    ["缺少必填字段", JSON.stringify({ id: projectId })],
    ["场景解析无效", JSON.stringify({ ...project(), scenes: [{ ...project().scenes[0]!, kind: "invalid-kind" }] })],
  ])("%s 必须抛出安全读取错误，不能返回 null 或有效 workspace 中的旧工程", (_label, raw) => {
    const store = pointReadMemory([...fullSeed(), [projectKey(), raw], [projectKey("foreign"), JSON.stringify(project("foreign"))]]);
    expect(() => readGitProject(projectId, store.storage)).toThrow(projectReadError);
    expectPointReads(store, reads);
  });
  it.each([0, 1])("按 UTF-8 字节检查 2 MiB 边界：超出字节=%s", excess => {
    const expected = project(), raw = JSON.stringify(expected), limit = 2 * 1024 * 1024;
    const padded = raw + " ".repeat(limit + excess - new TextEncoder().encode(raw).byteLength);
    expect(padded.length).toBeLessThan(limit); expect(new TextEncoder().encode(padded).byteLength).toBe(limit + excess);
    expect(parseProject(JSON.parse(padded))).toEqual(expected);
    const store = pointReadMemory([...fullSeed(), [projectKey(), padded]]);
    if (excess === 0) expect(readGitProject(projectId, store.storage)).toEqual(expected);
    else expect(() => readGitProject(projectId, store.storage)).toThrow(projectReadError);
    expectPointReads(store, reads);
  });
  it.each(reads)("读取 %s 抛错必须原样传播，不能吞错、包装为解析错误或降级", failedKey => {
    const store = pointReadMemory(fullSeed()), failure = new Error("读取被拒绝");
    vi.mocked(store.storage.getItem).mockImplementation(key => { if (key === failedKey) throw failure; return store.data.get(key) ?? null; });
    let caught: unknown; try { readGitProject(projectId, store.storage); } catch (cause) { caught = cause; }
    expect(caught).toBe(failure);
    expectPointReads(store, reads.slice(0, reads.indexOf(failedKey) + 1));
  });
});

describe("readLocalGitVersion 只读完整本机版本与确认后复验", () => {
  const versionKeys = [...attachmentKeys(), projectKey()];
  const boardReads = [`glint:project-board:v1:${projectId}`, `glint:project-board:viewport:v1:${projectId}`, `glint:project-board:groups:v1:${projectId}`, `glint:gen-canvas:v1:${projectId}`, `glint:gen-canvas:layout:v1:${projectId}`, `glint:gen-canvas:viewport:v1:${projectId}`];
  const watchedKeys = [...versionKeys, ...boardReads,nleRecordKey(projectId)];
  const barrierReads = [activeRestoreKey, journalKey()];
  const initialReads = [...barrierReads, ...watchedKeys, ...barrierReads, projectKey(), ...attachmentKeys(), ...boardReads,"glint.nle.save.v1",nleRecordKey(projectId), ...barrierReads,"glint.nle.save.v1", ...watchedKeys];
  const changedError = "本机工程或附件已变化，未载入过期版本。";
  function expectReadOnly(store: ReturnType<typeof pointReadMemory>, before = store.before) {
    const reads = vi.mocked(store.storage.getItem).mock.calls.map(([key]) => key);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every(key => [...watchedKeys, ...barrierReads,"glint.nle.save.v1"].includes(key))).toBe(true);
    expect(store.storage.setItem).not.toHaveBeenCalled(); expect(store.storage.removeItem).not.toHaveBeenCalled();
    expect(store.key).not.toHaveBeenCalled(); expect(store.length).not.toHaveBeenCalled();
    expect(store.snapshot()).toEqual(before);
  }
  const validJournal = (state: string) => JSON.stringify({ version: 2, projectId, state,
    entries: seed(projectId, "恢复").map(([key, after]) => ({ key, before: new Map(fullSeed()).get(key)!, after })) });

  it.each(["完整附件", "全部缺省", ...attachmentKeys()])("合法主快照与%s成功，只定点 get；重复复验也不写入或枚举", missing => {
    const values = fullSeed().filter(([key]) => missing === "全部缺省" ? !attachmentKeys().includes(key) : key !== missing);
    const store = pointReadMemory([...values, [workspaceKey, "{"], [BRAND_DRAFT_KEY, "{"], [journalKey("foreign"), "{"], [projectKey("foreign"), "{"]]);
    const result = readLocalGitVersion(projectId, store.storage);
    expect(result.project).toEqual(project(projectId, "原稿")); expect(result.assertCurrent).toBeTypeOf("function");
    expectPointReads(store, initialReads);
    expect(result.assertCurrent()).toBeUndefined(); expect(result.assertCurrent()).toBeUndefined();
    expectPointReads(store, [...initialReads, ...barrierReads,"glint.nle.save.v1", ...watchedKeys, ...barrierReads,"glint.nle.save.v1", ...watchedKeys]);
  });
  it("主快照不存在时拒绝，不从有效全局 workspace 或其他工程补回", () => {
    const store = pointReadMemory([...fullSeed().filter(([key]) => key !== projectKey()), [projectKey("foreign"), JSON.stringify(project("foreign"))]]);
    expect(() => readLocalGitVersion(projectId, store.storage)).toThrow("完整本机主快照已不存在，未载入旧版本。");
    expectPointReads(store, [...barrierReads, ...watchedKeys, ...barrierReads, projectKey()]);
  });
  it.each(["", "{", "null", "[]", JSON.stringify(project("foreign")), JSON.stringify({ id: projectId })])("主快照损坏或身份不匹配时拒绝：%j", raw => {
    const store = pointReadMemory([...fullSeed(), [projectKey(), raw]]);
    expect(() => readLocalGitVersion(projectId, store.storage)).toThrow(projectReadError);
    expectPointReads(store, [...barrierReads, ...watchedKeys, ...barrierReads, projectKey()]);
  });
  it.each(attachmentKeys().flatMap(key => ["", "{", "null", "{}"].map(raw => ({ key, raw }))))("坏附件 $key=$raw 必须拒绝且保留全部原始字节", ({ key, raw }) => {
    const store = pointReadMemory([...fullSeed(), [key, raw]]);
    expect(() => readLocalGitVersion(projectId, store.storage)).toThrow();
    expectReadOnly(store);
  });
  it.each([
    ["其他工程脚本", projectDocumentsKey(projectId), JSON.stringify(documents("foreign"))],
    ["无效脚本类型", projectDocumentsKey(projectId), JSON.stringify({ ...documents(), documents: [{ ...documents().documents[0]!, kind: "invalid" }] })],
    ["重复脚本文档", projectDocumentsKey(projectId), JSON.stringify({ ...documents(), documents: [documents().documents[0], documents().documents[0]] })],
    ["无效活动脚本", projectDocumentsKey(projectId), JSON.stringify({ ...documents(), activeId: "missing" })],
    ["其他工程设计", designDocumentsKey(projectId), JSON.stringify(workspace("foreign").designs)],
    ["设计未知字段", designDocumentsKey(projectId), JSON.stringify({ ...workspace().designs, unknown: true })],
    ["无效活动设计", designDocumentsKey(projectId), JSON.stringify({ ...workspace().designs, activeId: "missing" })],
    ["不安全固定品牌", projectBrandKey(projectId), JSON.stringify({ name: "品牌", colors: { accent: "red", bg: "#000000", text: "#ffffff" } })],
    ["无效素材路径", projectAssetsKey(projectId), JSON.stringify([{ name: "a.png", url: "/private/a.png", bytes: 1 }])],
    ["重复素材", projectAssetsKey(projectId), JSON.stringify([workspace().assets[0], workspace().assets[0]])],
    ["素材未知字段", projectAssetsKey(projectId), JSON.stringify([{ ...workspace().assets[0], unknown: true }])],
  ])("严格拒绝%s，不降级为空附件或覆盖原内容", (_label, key, raw) => {
    const store = pointReadMemory([...fullSeed(), [key, raw]]);
    expect(() => readLocalGitVersion(projectId, store.storage)).toThrow();
    expectReadOnly(store);
  });
  it.each(["prepared", "committed"])("存在合法 %s journal 时拒绝，不回放、回退或清理", state => {
    const store = pointReadMemory([...fullSeed(), ...seed(projectId, "恢复"), [journalKey(), validJournal(state)]]);
    expect(() => readLocalGitVersion(projectId, store.storage)).toThrow(readyError);
    expectPointReads(store, barrierReads);
  });
  it.each(activeValues)("全局 active=%j 存在即拒绝，不修改指针或原内容", active => {
    const store = pointReadMemory([...fullSeed(), [activeRestoreKey, active]]);
    expect(() => readLocalGitVersion(projectId, store.storage)).toThrow(readyError);
    expectPointReads(store, [activeRestoreKey]);
  });
  it.each(versionKeys.flatMap(key => ["仅原始字节变化", "删除"].map(mode => ({ key, mode }))))("获取后 $key 发生$mode，assertCurrent 拒绝且不覆盖变化", ({ key, mode }) => {
    const store = pointReadMemory(fullSeed()), result = readLocalGitVersion(projectId, store.storage);
    if (mode === "删除") store.data.delete(key); else store.data.set(key, `${store.data.get(key)!} `);
    const changed = store.snapshot();
    expect(() => result.assertCurrent()).toThrow(changedError);
    expect(result.project).toEqual(project(projectId, "原稿"));
    expectReadOnly(store, changed);
  });
  it.each(attachmentKeys())("原先缺省的 %s 在获取后新增，assertCurrent 也必须拒绝", key => {
    const store = pointReadMemory(fullSeed().filter(([item]) => item !== key)), result = readLocalGitVersion(projectId, store.storage);
    store.data.set(key, new Map(fullSeed()).get(key)!); const changed = store.snapshot();
    expect(() => result.assertCurrent()).toThrow(changedError);
    expectReadOnly(store, changed);
  });
  it.each(versionKeys)("读取 %s 期间发生合法 raw 字节变化，必须在返回收据前拒绝", changedKey => {
    const store = pointReadMemory(fullSeed()); let reads = 0;
    vi.mocked(store.storage.getItem).mockImplementation(key => {
      const raw = store.data.get(key) ?? null;
      if (key === changedKey && ++reads === 2) store.data.set(key, `${raw!} `);
      return raw;
    });
    expect(() => readLocalGitVersion(projectId, store.storage)).toThrow(changedError);
    expect(reads).toBe(3);
    const changed = memory([...fullSeed(), [changedKey, `${new Map(fullSeed()).get(changedKey)!} `]]).snapshot();
    expectReadOnly(store, changed);
  });
  it.each([
    ["迟到全局 active", activeRestoreKey, "foreign"],
    ["迟到 prepared journal", journalKey(), validJournal("prepared")],
    ["迟到 committed journal", journalKey(), validJournal("committed")],
  ])("confirm 期间%s，确认后 assertCurrent 拒绝，不接受旧工程", (_label, key, raw) => {
    const store = pointReadMemory(fullSeed()), result = readLocalGitVersion(projectId, store.storage), accept = vi.fn();
    const confirm = vi.fn(() => { store.data.set(key, raw); return true; });
    expect(() => { if (confirm()) { result.assertCurrent(); accept(result.project); } }).toThrow(readyError);
    expect(confirm).toHaveBeenCalledTimes(1); expect(accept).not.toHaveBeenCalled();
    expectReadOnly(store, memory([...fullSeed(), [key, raw]]).snapshot());
  });
  it.each([
    ["全局 active", activeRestoreKey, "foreign"],
    ["prepared journal", journalKey(), validJournal("prepared")],
    ["committed journal", journalKey(), validJournal("committed")],
  ])("读取附件期间迟到%s，返回前屏障仍必须拒绝", (_label, key, raw) => {
    const store = pointReadMemory(fullSeed()); let reads = 0;
    vi.mocked(store.storage.getItem).mockImplementation(item => {
      const value = store.data.get(item) ?? null;
      if (item === projectAssetsKey(projectId) && ++reads === 2) store.data.set(key, raw);
      return value;
    });
    expect(() => readLocalGitVersion(projectId, store.storage)).toThrow(readyError);
    expect(reads).toBe(2);
    expectReadOnly(store, memory([...fullSeed(), [key, raw]]).snapshot());
  });
  it("无关工程五类 key、journal、全局 workspace 与品牌草稿变化不影响获取或确认后复验", () => {
    const store = pointReadMemory([...fullSeed(), ...fullSeed("foreign")]);
    const result = readLocalGitVersion(projectId, store.storage);
    for (const [key, raw] of fullSeed("foreign")) store.data.set(key, `${raw} `);
    store.data.set(journalKey("foreign"), "{"); store.data.set(BRAND_DRAFT_KEY, "{"); const changed = store.snapshot();
    expect(result.assertCurrent()).toBeUndefined();
    expect(readLocalGitVersion(projectId, store.storage).project).toEqual(project(projectId, "原稿"));
    expectReadOnly(store, changed);
  });
});

describe("sameGitProject 规范 JSON 比较", () => {
  it("顶层、场景和嵌套旁白对象的 key 顺序不同仍视为同一工程，且不修改输入", () => {
    const left = project(), scene = left.scenes[0]!, narration = scene.narration!;
    const right: SceneScriptProject = { ...Object.fromEntries(Object.entries(left).reverse()), scenes: [{ ...Object.fromEntries(Object.entries(scene).reverse()), narration: Object.fromEntries(Object.entries(narration).reverse()) }] } as SceneScriptProject;
    const beforeLeft = JSON.stringify(left), beforeRight = JSON.stringify(right);
    expect(beforeLeft).not.toBe(beforeRight); expect(right).toEqual(left);
    expect(sameGitProject(left, right)).toBe(true); expect(sameGitProject(right, left)).toBe(true);
    expect(JSON.stringify(left)).toBe(beforeLeft); expect(JSON.stringify(right)).toBe(beforeRight);
  });
  it("相同 id 但嵌套旁白内容不同不能误判为同一工程", () => {
    const left = project(), right = project(); right.scenes[0]!.narration!.text = "不同旁白";
    expect(sameGitProject(left, right)).toBe(false); expect(sameGitProject(right, left)).toBe(false);
  });
  it("canonical 只忽略对象 key 顺序，不忽略场景数组顺序", () => {
    const first = project(), second = { ...project().scenes[0]!, id: "two", title: "第二场景" };
    const left = parseProject({ ...first, scenes: [...first.scenes, second] }), right = parseProject({ ...first, scenes: [second, ...first.scenes] });
    expect(sameGitProject(left, right)).toBe(false); expect(sameGitProject(right, left)).toBe(false);
  });
});

describe("saveLocalWorkspace 并发保存保护", () => {
  it("另一标签页恢复并清理完成后，旧 baseline 的600ms自动保存仍必须拒绝覆盖", () => {
    const store = memory(fullSeed()), baseline = store.data.get(workspaceKey)!;
    const otherTab: GitStorage = { getItem: key => store.data.get(key) ?? null, setItem: (key, value) => { store.data.set(key, value); }, removeItem: key => { store.data.delete(key); } };
    const tx = prepareGitStorage(projectId, documents(), workspace(), otherTab, false, project()); tx.write(); tx.commit(); tx.finish();
    const after = store.snapshot();
    expect(() => saveLocalWorkspace(studioWorkspace(project(projectId, "旧页面修改画幅")), baseline, store.storage)).toThrow(/其他窗口/);
    expect(store.snapshot()).toEqual(after);
  });
  it("同一页面恢复后的首个自动保存可更新资料，不把自己的事务误判为外来覆盖", () => {
    const store = memory(fullSeed()), baseline = store.data.get(workspaceKey)!;
    const tx = prepareGitStorage(projectId, documents(), workspace(), store.storage, false, project()); tx.write(); tx.commit(); tx.finish();
    const next = { ...studioWorkspace(project()), text: "恢复后新资料" };
    const raw = saveLocalWorkspace(next, baseline, store.storage);
    expect(JSON.parse(raw)).toEqual(next); expect(store.data.get(workspaceKey)).toBe(raw);
    expect(() => saveLocalWorkspace({ ...next, text: "继续修改" }, raw, store.storage)).not.toThrow();
  });
  it("同页连续恢复前后保持原baseline链，foreign更新仍使收据失效", () => {
    const store = memory(fullSeed()), baseline = store.data.get(workspaceKey)!;
    for (const title of ["第一次恢复", "第二次恢复"]) {
      const tx = prepareGitStorage(projectId, documents(), workspace(), store.storage, false, project(projectId, title)); tx.write(); tx.commit(); tx.finish();
    }
    expect(() => saveLocalWorkspace(studioWorkspace(project(projectId, "第二次恢复")), baseline, store.storage)).not.toThrow();
    store.data.set(workspaceKey, JSON.stringify({ ...studioWorkspace(), text: "foreign" })); const after = store.snapshot();
    expect(() => saveLocalWorkspace(studioWorkspace(), baseline, store.storage)).toThrow(/其他窗口/); expect(store.snapshot()).toEqual(after);
  });
  it("日志待清理时不允许自动保存改变已提交快照", () => {
    const store = memory(fullSeed()), baseline = store.data.get(workspaceKey)!;
    const tx = prepareGitStorage(projectId, documents(), workspace(), store.storage, false, project()); tx.write(); tx.commit();
    const after = store.snapshot(); expect(() => saveLocalWorkspace(studioWorkspace(), baseline, store.storage)).toThrow(/日志/); expect(store.snapshot()).toEqual(after);
  });
});

describe("captureProjectWorkspace 严格捕获", () => {
  it("捕获本工程设计、固定品牌与素材引用，不读取工作室品牌或改写存储", () => {
    const store = memory([...seed(), [BRAND_DRAFT_KEY, "损坏的全局草稿"]]);
    expect(captureProjectWorkspace(projectId, undefined, store.storage)).toEqual(workspace(projectId, "原稿"));
    expect(store.storage.setItem).not.toHaveBeenCalled(); expect(store.storage.removeItem).not.toHaveBeenCalled();
  });
  it("内存设计优先，但品牌和素材每次从磁盘重新读取", () => {
    const store = memory(seed()), draft = workspace(projectId, "内存草稿");
    expect(captureProjectWorkspace(projectId, draft.designs, store.storage)).toEqual({ ...workspace(projectId, "原稿"), designs: draft.designs });
    store.data.set(projectBrandKey(projectId), projectBrandRaw(draft.brand!)); store.data.set(projectAssetsKey(projectId), "[]");
    expect(captureProjectWorkspace(projectId, draft.designs, store.storage)).toEqual({ ...draft, assets: [] });
  });
  it("缺失存储产生显式空附件，不继承全局品牌", () => {
    const store = memory([[BRAND_DRAFT_KEY, projectBrandRaw(workspace().brand!)]]);
    expect(captureProjectWorkspace(projectId, undefined, store.storage)).toEqual({ version: 1, projectId, designs: { version: 1, projectId, documents: [], activeId: "" }, brand: null, assets: [] });
  });
  it.each([
    ["损坏设计 JSON", designDocumentsKey(projectId), "{"],
    ["其他工程设计", designDocumentsKey(projectId), JSON.stringify(workspace("foreign").designs)],
    ["损坏固定品牌", projectBrandKey(projectId), "{"],
    ["不安全品牌", projectBrandKey(projectId), JSON.stringify({ name: "品牌", colors: { accent: "red" } })],
    ["损坏素材 JSON", projectAssetsKey(projectId), "{"],
    ["无效素材路径", projectAssetsKey(projectId), JSON.stringify([{ name: "a.png", url: "/private/a.png", bytes: 1 }])],
    ["重复素材", projectAssetsKey(projectId), JSON.stringify([workspace().assets[0], workspace().assets[0]])],
  ])("%s 必须阻止捕获，即使提供有效内存草稿也不覆盖旧数据", (_label, key, raw) => {
    const store = memory(seed()); store.data.set(key, raw); const before = store.snapshot();
    expect(() => captureProjectWorkspace(projectId, workspace().designs, store.storage)).toThrow();
    expect(store.snapshot()).toEqual(before); expect(store.storage.setItem).not.toHaveBeenCalled(); expect(store.storage.removeItem).not.toHaveBeenCalled();
  });
  it.each(["未知字段", "33 文档", "总计 101 页", "HTML UTF-8 超限"])("磁盘设计即使被内存草稿遮蔽，也必须拒绝 %s", mode => {
    const corrupt = workspace().designs, doc = corrupt.documents[0]!;
    if (mode === "未知字段") Object.assign(doc.pages[0]!, { unknown: "不可静默丢弃" });
    if (mode === "33 文档") { corrupt.documents = Array.from({ length: 33 }, (_, index) => ({ ...doc, id: `design-${index}` })); corrupt.activeId = "design-0"; }
    if (mode === "总计 101 页") { doc.pages = Array.from({ length: 100 }, (_, index) => ({ ...doc.pages[0]!, id: `page-${index}` })); doc.activePageId = "page-0"; corrupt.documents.push({ ...doc, id: "second", pages: [doc.pages[0]!] }); }
    if (mode === "HTML UTF-8 超限") doc.pages[0]!.html = "界".repeat(Math.floor(1024 * 1024 / 3) + 1);
    const store = memory([[designDocumentsKey(projectId), JSON.stringify(corrupt)]]), before = store.snapshot();
    expect(() => captureProjectWorkspace(projectId, workspace().designs, store.storage)).toThrow();
    expect(store.snapshot()).toEqual(before);
  });
  it("存储读取权限失败不能伪装成空 workspace", () => {
    const store = memory(); vi.mocked(store.storage.getItem).mockImplementation(() => { throw new Error("读取被拒绝"); });
    expect(() => captureProjectWorkspace(projectId, undefined, store.storage)).toThrow(); expect(store.storage.setItem).not.toHaveBeenCalled();
  });
});

describe("prepareGitStorage 事务恢复", () => {
  it("prepare 不写入；write 先备份全部附件；commit 持久化提交标记后 finish 才清理", () => {
    const store = memory(seed()), before = store.snapshot(), next = workspace(), script = documents();
    const tx = prepareGitStorage(projectId, script, next, store.storage);
    const entries = attachmentKeys().map(key => ({ key, before: new Map(before).get(key), after: key === projectDocumentsKey(projectId) ? JSON.stringify(script) : key === designDocumentsKey(projectId) ? JSON.stringify(parseProjectWorkspace(next, projectId).designs) : key === projectBrandKey(projectId) ? projectBrandRaw(next.brand!) : JSON.stringify(next.assets) }));
    expect(store.snapshot()).toEqual(before); expect(store.storage.setItem).not.toHaveBeenCalled();
    vi.mocked(store.storage.setItem).mockImplementation((key, value) => {
      if (attachmentKeys().includes(key)) expect(readJournal(store)).toMatchObject({ version: 2, state: "prepared", entries });
      store.data.set(key, value);
    });
    tx.write(); expect(readJournal(store)).toMatchObject({ version: 2, state: "prepared", entries });
    for (const entry of entries) expect(store.data.get(entry.key)).toBe(entry.after);
    tx.commit(); expect(readJournal(store)).toMatchObject({ version: 2, state: "committed", entries });
    expect(tx.finish()).toBeUndefined(); expect(store.data.has(journalKey())).toBe(false); expect(store.data.has(activeRestoreKey)).toBe(false);
    const finished = store.snapshot(); tx.rollback(); tx.write(); tx.commit(); expect(tx.finish()).toBeUndefined(); expect(store.snapshot()).toEqual(finished);
  });
  it("finish 在 write 前调用无效，不能跳过备份或阻止后续写入", () => {
    const store = memory(seed()), tx = prepareGitStorage(projectId, documents(), workspace(), store.storage);
    tx.finish(); expect(store.storage.removeItem).not.toHaveBeenCalled(); tx.write(); expect(store.data.has(journalKey())).toBe(true);
    tx.commit(); expect(tx.finish()).toBeUndefined(); expect(store.data.has(journalKey())).toBe(false);
  });
  it.each([false, true])("编辑器拒绝后 rollback 精确恢复原始字节及原先缺失 key：空存储=%s", empty => {
    const store = memory(empty ? [] : seed()), before = store.snapshot(), tx = prepareGitStorage(projectId, documents(), workspace(), store.storage);
    tx.write(); tx.rollback(); expect(store.snapshot()).toEqual(before); tx.rollback(); expect(store.snapshot()).toEqual(before);
  });
  it("恢复旧版缺 workspace 时仅替换脚本，不清空设计、品牌或素材", () => {
    const store = memory(seed()), before = new Map(store.data), tx = prepareGitStorage(projectId, documents(), undefined, store.storage);
    tx.write(); tx.commit(); tx.finish(); expect(store.data.get(projectDocumentsKey(projectId))).toBe(JSON.stringify(documents()));
    for (const key of attachmentKeys().slice(1)) expect(store.data.get(key)).toBe(before.get(key));
  });
  it("显式空 workspace 会清空附件并删除品牌，回退时恢复被删除品牌", () => {
    const store = memory(seed()), before = store.snapshot(), empty: ProjectWorkspace = { version: 1, projectId, designs: { version: 1, projectId, documents: [], activeId: "" }, brand: null, assets: [] };
    const tx = prepareGitStorage(projectId, undefined, empty, store.storage); tx.write();
    expect(store.data.has(projectBrandKey(projectId))).toBe(false); expect(store.data.get(projectAssetsKey(projectId))).toBe("[]");
    tx.rollback(); expect(store.snapshot()).toEqual(before);
  });
  it.each(attachmentKeys())("在写入 %s 失败后回退所有此前写入", failedKey => {
    const store = memory(seed()), before = store.snapshot(), tx = prepareGitStorage(projectId, documents(), workspace(), store.storage);
    let failed = false; vi.mocked(store.storage.setItem).mockImplementation((key, value) => { if (key === failedKey && !failed) { failed = true; throw new Error("空间不足"); } store.data.set(key, value); });
    expect(() => tx.write()).toThrow(/空间不足/); expect(store.snapshot()).toEqual(before);
  });
  it("日志写入失败时不开始附件写入", () => {
    const store = memory(seed()), before = store.snapshot(), tx = prepareGitStorage(projectId, documents(), workspace(), store.storage);
    vi.mocked(store.storage.setItem).mockImplementation(() => { throw new Error("日志无法持久化"); });
    expect(() => tx.write()).toThrow(/日志无法持久化/); expect(store.snapshot()).toEqual(before); expect(store.storage.setItem).toHaveBeenCalledTimes(1);
  });
  it("写入核对失败自动回退，不报告恢复成功", () => {
    const store = memory(seed()), before = store.snapshot(), tx = prepareGitStorage(projectId, documents(), workspace(), store.storage);
    vi.mocked(store.storage.setItem).mockImplementation((key, value) => { if (key !== designDocumentsKey(projectId)) store.data.set(key, value); });
    expect(() => tx.write()).toThrow(/写入未通过核对/); expect(store.snapshot()).toEqual(before);
  });
  it("prepare 后其他窗口更改任何待写附件，write 不写日志也不覆盖", () => {
    const store = memory(seed()), tx = prepareGitStorage(projectId, documents(), workspace(), store.storage);
    store.data.set(projectAssetsKey(projectId), "外部新值"); const before = store.snapshot();
    expect(() => tx.write()).toThrow(/其他窗口/); expect(store.snapshot()).toEqual(before); expect(store.storage.setItem).not.toHaveBeenCalled();
  });
  it("写入期间发生 foreign 并发更新，保留其值及 journal，稍后人工核对", () => {
    const store = memory(seed()), tx = prepareGitStorage(projectId, documents(), workspace(), store.storage);
    vi.mocked(store.storage.setItem).mockImplementation((key, value) => { store.data.set(key, value); if (key === projectDocumentsKey(projectId)) store.data.set(designDocumentsKey(projectId), "foreign"); });
    expect(() => tx.write()).toThrow(/回退尚未完成/); expect(store.data.get(designDocumentsKey(projectId))).toBe("foreign"); expect(store.data.has(journalKey())).toBe(true);
    expect(() => recoverGitStorage(projectId, store.storage)).toThrow(/其他窗口/); expect(store.data.get(designDocumentsKey(projectId))).toBe("foreign");
  });
  it("回退写失败保留日志，权限恢复后 recover 可以继续回退", () => {
    const store = memory(seed()), before = store.snapshot(), tx = prepareGitStorage(projectId, documents(), workspace(), store.storage);
    vi.mocked(store.storage.setItem).mockImplementation((key, value) => {
      if (key === designDocumentsKey(projectId) || key === projectDocumentsKey(projectId) && value === new Map(before).get(key)) throw new Error("权限丢失");
      store.data.set(key, value);
    });
    expect(() => tx.write()).toThrow(/回退尚未完成/); expect(store.data.has(journalKey())).toBe(true);
    vi.mocked(store.storage.setItem).mockImplementation((key, value) => { store.data.set(key, value); });
    recoverGitStorage(projectId, store.storage); expect(store.snapshot()).toEqual(before);
  });
  it.each(attachmentKeys())("copy 目标已有 %s，即使本次不写该 key 也拒绝碰撞", key => {
    const store = memory([[key, seed().find(([item]) => item === key)![1]]]), before = store.snapshot();
    expect(() => prepareGitStorage(projectId, documents(), undefined, store.storage, true)).toThrow(/副本编号已存在/);
    expect(store.snapshot()).toEqual(before); expect(store.storage.setItem).not.toHaveBeenCalled();
  });
  it("copy 在 prepare 后出现原本不在待写列表中的目标附件，也必须拒绝碰撞", () => {
    const store = memory(), tx = prepareGitStorage(projectId, documents(), undefined, store.storage, true);
    store.data.set(projectAssetsKey(projectId), JSON.stringify(workspace().assets)); const before = store.snapshot();
    expect(() => tx.write()).toThrow(/副本编号已存在|其他窗口/); expect(store.snapshot()).toEqual(before); expect(store.storage.setItem).not.toHaveBeenCalled();
  });
  it("commit 先持久化；finish 删除日志失败返回警告；以后 recover 只清理并保留 after", () => {
    const store = memory(fullSeed()), tx = prepareGitStorage(projectId, documents(), workspace(), store.storage, false, project());
    tx.write(); const prepared = readJournal(store); tx.commit();
    expect(readJournal(store)).toEqual({ ...prepared, version: 2, state: "committed" });
    const after = transactionKeys().map(key => [key, store.data.get(key)]);
    vi.mocked(store.storage.removeItem).mockImplementation(key => { if (key === journalKey()) throw new Error("日志清理被拒绝"); store.data.delete(key); });
    let warning: string | undefined;
    expect(() => { warning = tx.finish(); }).not.toThrow(); expect(warning).toEqual(expect.any(String)); expect(warning!.trim().length).toBeGreaterThan(0);
    expect(readJournal(store).state).toBe("committed");
    const finished = store.snapshot(); tx.rollback(); expect(store.snapshot()).toEqual(finished);
    const restarted = memory([...store.data]);
    recoverGitStorage(projectId, restarted.storage);
    expect(transactionKeys().map(key => [key, restarted.data.get(key)])).toEqual(after);
    expect(restarted.data.has(journalKey())).toBe(false); expect(restarted.data.has(activeRestoreKey)).toBe(false);
    expect(restarted.storage.setItem).not.toHaveBeenCalled();
  });
  it("独立 copy 仅写目标编号，原工程和其他工程附件完全不变", () => {
    const store = memory(seed()), before = new Map(store.data), copyId = "copy-id", value = workspace(copyId);
    const tx = prepareGitStorage(copyId, documents(copyId), value, store.storage, true); tx.write(); tx.commit(); tx.finish();
    expect(captureProjectWorkspace(copyId, undefined, store.storage)).toEqual(value);
    for (const [key, raw] of before) expect(store.data.get(key)).toBe(raw);
  });
  it.each(attachmentKeys())("准备恢复时拒绝本机损坏的 %s，不能写日志或其他 key", key => {
    const store = memory(seed()); store.data.set(key, "{"); const before = store.snapshot();
    expect(() => prepareGitStorage(projectId, documents(), workspace(), store.storage)).toThrow(); expect(store.snapshot()).toEqual(before); expect(store.storage.setItem).not.toHaveBeenCalled();
  });
});

describe("v2 工程、附件与全局 workspace 原子事务", () => {
  it("六类新值全部在 write 落盘，独立快照与 workspace 同步且保留其他字段", () => {
    const store = memory(fullSeed()), before = new Map(store.data), next = project();
    const tx = prepareGitStorage(projectId, documents(), workspace(), store.storage, false, next);
    expect(store.snapshot()).toEqual(memory([...before]).snapshot()); expect(store.storage.setItem).not.toHaveBeenCalled();
    const after = expectedAfter(before);
    vi.mocked(store.storage.setItem).mockImplementation((key, value) => {
      if (transactionKeys().includes(key)) {
        expect(readJournal(store)).toMatchObject({ version: 2, state: "prepared" });
        expect(readJournal(store).entries).toHaveLength(6);
        expectActiveProject(store);
      }
      store.data.set(key, value);
    });
    tx.write();
    const saved = readJournal(store);
    expect(saved.entries.map(entry => entry.key).sort()).toEqual(transactionKeys().sort());
    expect(saved.entries).toEqual(expect.arrayContaining([...after].map(([key, value]) => ({ key, before: before.get(key), after: value }))));
    for (const [key, value] of after) expect(store.data.get(key)).toBe(value);
    expect(JSON.parse(store.data.get(projectKey())!)).toEqual(next);
    expect(JSON.parse(store.data.get(workspaceKey)!)).toEqual({ ...studioWorkspace(), project: next });
    const parent = vi.fn(() => {
      expect(readJournal(store)).toEqual({ ...saved, state: "committed" });
      for (const [key, value] of after) expect(store.data.get(key)).toBe(value);
    });
    tx.commit(); parent(); expect(parent).toHaveBeenCalledTimes(1);
    expect(tx.finish()).toBeUndefined(); expect(store.data.has(journalKey())).toBe(false); expect(store.data.has(activeRestoreKey)).toBe(false);
  });
  it.each([false, true])("父回调抛错时在 finish 前显式回退全部六键，包括 committed：原存储为空=%s", empty => {
    const store = memory(empty ? [] : fullSeed()), before = store.snapshot();
    const tx = prepareGitStorage(projectId, documents(), workspace(), store.storage, false, project());
    tx.write(); tx.commit(); expect(readJournal(store).state).toBe("committed");
    const parent = vi.fn(() => { throw new Error("父组件拒绝工程"); });
    expect(() => { try { parent(); } catch (cause) { tx.rollback(); throw cause; } }).toThrow("父组件拒绝工程");
    expect(store.snapshot()).toEqual(before); tx.rollback(); expect(tx.finish()).toBeUndefined(); expect(store.snapshot()).toEqual(before);
  });
  it.each(transactionKeys())("写入 %s 失败时自动恢复所有原始字节并清理事务元数据", failedKey => {
    const store = memory(fullSeed()), before = store.snapshot();
    const tx = prepareGitStorage(projectId, documents(), workspace(), store.storage, false, project());
    let failed = false;
    vi.mocked(store.storage.setItem).mockImplementation((key, value) => {
      if (key === failedKey && !failed) { failed = true; throw new Error("事务空间不足"); }
      store.data.set(key, value);
    });
    expect(() => tx.write()).toThrow(/事务空间不足/); expect(failed).toBe(true); expect(store.snapshot()).toEqual(before);
  });
  it.each([projectKey(), workspaceKey])("%s 静默丢写也必须核对失败并全量回退", failedKey => {
    const store = memory(fullSeed()), before = store.snapshot();
    const tx = prepareGitStorage(projectId, documents(), workspace(), store.storage, false, project());
    vi.mocked(store.storage.setItem).mockImplementation((key, value) => { if (key !== failedKey) store.data.set(key, value); });
    expect(() => tx.write()).toThrow(/写入未通过核对/); expect(store.snapshot()).toEqual(before);
  });
  it("提交标记写失败不能调用父回调，可显式全量回退", () => {
    const store = memory(fullSeed()), before = store.snapshot(), parent = vi.fn();
    const tx = prepareGitStorage(projectId, documents(), workspace(), store.storage, false, project()); tx.write();
    vi.mocked(store.storage.setItem).mockImplementation((key, value) => {
      if (key === journalKey() && JSON.parse(value).state === "committed") throw new Error("提交标记写入失败");
      store.data.set(key, value);
    });
    expect(() => { tx.commit(); parent(); }).toThrow(/提交标记写入失败/); expect(parent).not.toHaveBeenCalled();
    tx.rollback(); expect(store.snapshot()).toEqual(before);
  });
  it("提交标记静默丢写不能视为提交成功，必须核对且支持回退", () => {
    const store = memory(fullSeed()), before = store.snapshot(), parent = vi.fn();
    const tx = prepareGitStorage(projectId, documents(), workspace(), store.storage, false, project()); tx.write();
    vi.mocked(store.storage.setItem).mockImplementation((key, value) => { if (key !== journalKey() || JSON.parse(value).state !== "committed") store.data.set(key, value); });
    expect(() => { tx.commit(); parent(); }).toThrow(/提交|核对/); expect(parent).not.toHaveBeenCalled();
    tx.rollback(); expect(store.snapshot()).toEqual(before);
  });
  it.each([false, true])("copy 主工程快照 key 碰撞必须拒绝，包括 prepare 后才出现：%s", late => {
    const raw = JSON.stringify(project()), store = memory(late ? [] : [[projectKey(), raw]]);
    if (late) {
      const tx = prepareGitStorage(projectId, documents(), undefined, store.storage, true);
      store.data.set(projectKey(), raw); const before = store.snapshot();
      expect(() => tx.write()).toThrow(/副本编号已存在|其他窗口/); expect(store.snapshot()).toEqual(before);
    } else {
      const before = store.snapshot(); expect(() => prepareGitStorage(projectId, documents(), undefined, store.storage, true)).toThrow(/副本编号已存在/);
      expect(store.snapshot()).toEqual(before);
    }
    expect(store.storage.setItem).not.toHaveBeenCalled(); expect(store.storage.removeItem).not.toHaveBeenCalled();
  });
  it.each([projectKey(), workspaceKey])("prepare 后 %s 被其他窗口修改，write 不得写日志或覆盖", key => {
    const store = memory(fullSeed()), tx = prepareGitStorage(projectId, documents(), workspace(), store.storage, false, project());
    store.data.set(key, JSON.stringify({ foreign: true })); const before = store.snapshot();
    expect(() => tx.write()).toThrow(/其他窗口/); expect(store.snapshot()).toEqual(before); expect(store.storage.setItem).not.toHaveBeenCalled();
  });
  it("写入过程中 global workspace 发生并发更新，不能被覆盖或在 recover 时回退", () => {
    const store = memory(fullSeed()), tx = prepareGitStorage(projectId, documents(), workspace(), store.storage, false, project());
    const foreign = JSON.stringify(studioWorkspace(project("foreign", "另一个窗口")));
    vi.mocked(store.storage.setItem).mockImplementation((key, value) => {
      store.data.set(key, value); if (key === projectDocumentsKey(projectId)) store.data.set(workspaceKey, foreign);
    });
    expect(() => tx.write()).toThrow(); expect(store.data.get(workspaceKey)).toBe(foreign); expect(store.data.has(journalKey())).toBe(true);
    const restarted = memory([...store.data]), before = restarted.snapshot();
    expect(() => recoverGitWorkspace(restarted.storage)).toThrow(); expect(restarted.snapshot()).toEqual(before);
    expect(restarted.storage.setItem).not.toHaveBeenCalled(); expect(restarted.storage.removeItem).not.toHaveBeenCalled();
  });
  it("全局指针持久化失败时不能开始写六类数据，允许恢复原状", () => {
    const store = memory(fullSeed()), before = store.snapshot();
    const tx = prepareGitStorage(projectId, documents(), workspace(), store.storage, false, project());
    vi.mocked(store.storage.setItem).mockImplementation((key, value) => { if (key === activeRestoreKey) throw new Error("指针写入失败"); store.data.set(key, value); });
    expect(() => tx.write()).toThrow(/指针写入失败/); tx.rollback(); expect(store.snapshot()).toEqual(before);
    expect(vi.mocked(store.storage.setItem).mock.calls.filter(([key]) => transactionKeys().includes(key))).toHaveLength(0);
  });
});

describe("回退与清理静默失效的精确故障注入", () => {
  it.each([false, true].flatMap(empty => transactionKeys().map(failedKey => ({ empty, failedKey }))))("write 后仅回退 $failedKey 静默失效必须保留 prepared 与活动指针：空存储=$empty", ({ empty, failedKey }) => {
    const store = memory(empty ? [] : fullSeed()), before = store.snapshot(), original = new Map(before);
    const tx = prepareGitStorage(projectId, documents(), workspace(), store.storage, false, project());
    tx.write();
    const preparedRaw = store.data.get(journalKey())!, activeRaw = store.data.get(activeRestoreKey)!;
    const entries = readJournal(store).entries;
    expect(entries.map(entry => entry.key).sort()).toEqual(transactionKeys().sort());
    for (const entry of entries) {
      expect(entry.before).toBe(original.get(entry.key) ?? null);
      expect(entry.after).not.toBe(entry.before);
      expect(store.data.get(entry.key) ?? null).toBe(entry.after);
    }
    const failedEntry = entries.find(entry => entry.key === failedKey)!;
    let dropped = 0;
    vi.mocked(store.storage.setItem).mockImplementation((key, value) => {
      if (key === failedKey && value === failedEntry.before) { dropped++; return; }
      store.data.set(key, value);
    });
    vi.mocked(store.storage.removeItem).mockImplementation(key => {
      if (key === failedKey && failedEntry.before === null) { dropped++; return; }
      store.data.delete(key);
    });
    expect(() => tx.rollback()).toThrow(/恢复|回退|核对/);
    expect(dropped).toBeGreaterThan(0);
    expect(store.data.get(failedKey) ?? null).toBe(failedEntry.after);
    expect(store.data.get(journalKey())).toBe(preparedRaw); expect(readJournal(store).state).toBe("prepared");
    expect(store.data.get(activeRestoreKey)).toBe(activeRaw); expectActiveProject(store);
    vi.mocked(store.storage.setItem).mockImplementation((key, value) => { store.data.set(key, value); });
    vi.mocked(store.storage.removeItem).mockImplementation(key => { store.data.delete(key); });
    const restarted = memory([...store.data]);
    expect(recoverGitWorkspace(restarted.storage)).toEqual(empty ? null : studioWorkspace());
    expect(restarted.snapshot()).toEqual(before);
    expect(recoverGitWorkspace(restarted.storage)).toEqual(empty ? null : studioWorkspace());
    expect(restarted.snapshot()).toEqual(before);
  });

  it.each(["prepared", "committed"].flatMap(state => [journalKey(), activeRestoreKey].map(failedKey => ({ state, failedKey }))))("$state 清理 $failedKey 静默丢删必须保留保存屏障，启动清理后才解除", ({ state, failedKey }) => {
    const store = memory(fullSeed()), original = new Map(store.data);
    const tx = prepareGitStorage(projectId, documents(), workspace(), store.storage, false, project());
    tx.write(); if (state === "committed") tx.commit();
    const journalRaw = store.data.get(journalKey())!, activeRaw = store.data.get(activeRestoreKey)!;
    const expected = state === "committed" ? expectedAfter(original) : original;
    vi.mocked(store.storage.removeItem).mockClear();
    let dropped = 0;
    vi.mocked(store.storage.removeItem).mockImplementation(key => {
      if (key === failedKey) { dropped++; return; }
      store.data.delete(key);
    });
    if (state === "committed") {
      let warning: string | undefined;
      expect(() => { warning = tx.finish(); }).not.toThrow();
      expect(warning).toEqual(expect.any(String)); expect(warning!.trim().length).toBeGreaterThan(0);
    } else {
      try { tx.rollback(); } catch (cause) { expect(cause).toBeInstanceOf(Error); expect((cause as Error).message).toMatch(/清理|日志|核对|恢复|回退/); }
    }
    expect(dropped).toBeGreaterThan(0);
    for (const [key, raw] of expected) expect(store.data.get(key)).toBe(raw);
    if (failedKey === journalKey()) {
      expect(store.data.get(journalKey())).toBe(journalRaw); expect(readJournal(store).state).toBe(state);
      expect(store.storage.removeItem).not.toHaveBeenCalledWith(activeRestoreKey);
    }
    expect(store.data.get(activeRestoreKey)).toBe(activeRaw); expectActiveProject(store);
    const blocked = store.snapshot(), baseline = store.data.get(workspaceKey)!;
    expect(() => saveLocalWorkspace({ ...studioWorkspace(), text: "清理前不得保存" }, baseline, store.storage)).toThrow(/日志|恢复|清理/);
    expect(store.snapshot()).toEqual(blocked);
    const restarted = memory([...store.data]);
    vi.mocked(restarted.storage.removeItem).mockImplementation(key => { if (key !== failedKey) restarted.data.delete(key); });
    const expectedWorkspace = state === "committed" ? { ...studioWorkspace(), project: project() } : studioWorkspace();
    expect(recoverGitWorkspace(restarted.storage)).toEqual(expectedWorkspace);
    for (const [key, raw] of expected) expect(restarted.data.get(key)).toBe(raw);
    expect(restarted.data.get(activeRestoreKey)).toBe(activeRaw); expectActiveProject(restarted);
    if (failedKey === journalKey()) {
      expect(restarted.data.get(journalKey())).toBe(journalRaw);
      expect(restarted.storage.removeItem).not.toHaveBeenCalledWith(activeRestoreKey);
    }
    vi.mocked(restarted.storage.removeItem).mockImplementation(key => { restarted.data.delete(key); });
    const stillBlocked = restarted.snapshot();
    expect(() => saveLocalWorkspace({ ...expectedWorkspace, text: "权限恢复但尚未启动清理" }, baseline, restarted.storage)).toThrow(/日志|恢复|清理/);
    expect(restarted.snapshot()).toEqual(stillBlocked);
    expect(recoverGitWorkspace(restarted.storage)).toEqual(expectedWorkspace);
    expect(restarted.snapshot()).toEqual(memory([...expected]).snapshot());
    expect(restarted.data.has(journalKey())).toBe(false); expect(restarted.data.has(activeRestoreKey)).toBe(false);
    const next = { ...expectedWorkspace, text: "启动清理后正常保存" };
    const raw = saveLocalWorkspace(next, baseline, restarted.storage);
    expect(raw).toBe(JSON.stringify(next)); expect(restarted.data.get(workspaceKey)).toBe(raw);
    for (const key of transactionKeys().filter(key => key !== workspaceKey)) expect(restarted.data.get(key)).toBe(expected.get(key));
  });

  it.each([false, true].flatMap(empty => transactionKeys().map(failedKey => ({ empty, failedKey }))))("启动直接回退 prepared 时 $failedKey 静默失效必须抛错且保留日志：空存储=$empty", ({ empty, failedKey }) => {
    const store = memory(empty ? [] : fullSeed()), before = store.snapshot(), original = new Map(before);
    const tx = prepareGitStorage(projectId, documents(), workspace(), store.storage, false, project()); tx.write();
    const restarted = memory([...store.data]), preparedRaw = restarted.data.get(journalKey())!, activeRaw = restarted.data.get(activeRestoreKey)!;
    const entries = readJournal(restarted).entries;
    expect(entries.map(entry => entry.key).sort()).toEqual(transactionKeys().sort());
    for (const entry of entries) {
      expect(entry.before).toBe(original.get(entry.key) ?? null);
      expect(entry.after).not.toBe(entry.before);
      expect(restarted.data.get(entry.key) ?? null).toBe(entry.after);
    }
    const failedEntry = entries.find(entry => entry.key === failedKey)!;
    let dropped = 0;
    vi.mocked(restarted.storage.setItem).mockImplementation((key, value) => {
      if (key === failedKey && value === failedEntry.before) { dropped++; return; }
      restarted.data.set(key, value);
    });
    vi.mocked(restarted.storage.removeItem).mockImplementation(key => {
      if (key === failedKey && failedEntry.before === null) { dropped++; return; }
      restarted.data.delete(key);
    });
    expect(() => recoverGitWorkspace(restarted.storage)).toThrow(/恢复|回退|核对/);
    expect(dropped).toBeGreaterThan(0);
    expect(restarted.data.get(failedKey) ?? null).toBe(failedEntry.after);
    expect(restarted.data.get(journalKey())).toBe(preparedRaw); expect(readJournal(restarted).state).toBe("prepared");
    expect(restarted.data.get(activeRestoreKey)).toBe(activeRaw); expectActiveProject(restarted);
    expect(restarted.storage.removeItem).not.toHaveBeenCalledWith(journalKey());
    expect(restarted.storage.removeItem).not.toHaveBeenCalledWith(activeRestoreKey);
    vi.mocked(restarted.storage.setItem).mockImplementation((key, value) => { restarted.data.set(key, value); });
    vi.mocked(restarted.storage.removeItem).mockImplementation(key => { restarted.data.delete(key); });
    expect(recoverGitWorkspace(restarted.storage)).toEqual(empty ? null : studioWorkspace());
    expect(restarted.snapshot()).toEqual(before);
  });
});

describe("recoverGitWorkspace 启动恢复与提交后清理", () => {
  it("无指针时返回当前 workspace；缺失 workspace 时返回 null，均不写入", () => {
    const empty = memory(); expect(recoverGitWorkspace(empty.storage)).toBeNull();
    expect(empty.storage.setItem).not.toHaveBeenCalled(); expect(empty.storage.removeItem).not.toHaveBeenCalled();
    const store = memory(fullSeed()); expect(recoverGitWorkspace(store.storage)).toEqual(studioWorkspace());
    expect(store.storage.setItem).not.toHaveBeenCalled(); expect(store.storage.removeItem).not.toHaveBeenCalled();
  });
  it.each([false, true])("prepared 中断重启回退全部六键，并返回恢复后重读的 workspace：空存储=%s", empty => {
    const store = memory(empty ? [] : fullSeed()), before = store.snapshot();
    const tx = prepareGitStorage(projectId, documents(), workspace(), store.storage, false, project()); tx.write();
    expect(readJournal(store).state).toBe("prepared"); expectActiveProject(store);
    const restarted = memory([...store.data]);
    expect(recoverGitWorkspace(restarted.storage)).toEqual(empty ? null : studioWorkspace()); expect(restarted.snapshot()).toEqual(before);
    expect(recoverGitWorkspace(restarted.storage)).toEqual(empty ? null : studioWorkspace()); expect(restarted.snapshot()).toEqual(before);
  });
  it("新副本 write 后中断，启动依据全局指针找到副本并恢复原工作区，不残留副本六键", () => {
    const store = memory(fullSeed()), before = store.snapshot(), copyId = "interrupted-copy";
    const tx = prepareGitStorage(copyId, documents(copyId), workspace(copyId), store.storage, true, project(copyId)); tx.write();
    expectActiveProject(store, copyId); expect(JSON.parse(store.data.get(workspaceKey)!).project.id).toBe(copyId);
    for (const key of transactionKeys(copyId).filter(key => key !== workspaceKey)) expect(store.data.has(key)).toBe(true);
    const restarted = memory([...store.data]); expect(recoverGitWorkspace(restarted.storage)).toEqual(studioWorkspace());
    expect(restarted.snapshot()).toEqual(before); expect(restarted.data.has(journalKey(copyId))).toBe(false); expect(restarted.data.has(activeRestoreKey)).toBe(false);
  });
  it.each([false, true])("prepared 仅部分 key 已落盘也必须全量恢复，包含删除原先缺失 key：%s", empty => {
    const store = memory(empty ? [] : fullSeed()), before = store.snapshot();
    const tx = prepareGitStorage(projectId, documents(), workspace(), store.storage, false, project()); tx.write();
    const entries = readJournal(store).entries;
    for (const entry of entries.filter((_entry, index) => index % 2 === 0)) {
      if (entry.before === null) store.data.delete(entry.key); else store.data.set(entry.key, entry.before);
    }
    const restarted = memory([...store.data]); expect(recoverGitWorkspace(restarted.storage)).toEqual(empty ? null : studioWorkspace());
    expect(restarted.snapshot()).toEqual(before);
  });
  it("commit 后未 finish 即重启只能清理，不得回退任何 after", () => {
    const store = memory(fullSeed()), after = expectedAfter(new Map(store.data));
    const tx = prepareGitStorage(projectId, documents(), workspace(), store.storage, false, project()); tx.write(); tx.commit();
    const restarted = memory([...store.data]); expect(recoverGitWorkspace(restarted.storage)).toEqual({ ...studioWorkspace(), project: project() });
    for (const [key, raw] of after) expect(restarted.data.get(key)).toBe(raw);
    expect(restarted.storage.setItem).not.toHaveBeenCalled(); expect(restarted.data.has(journalKey())).toBe(false); expect(restarted.data.has(activeRestoreKey)).toBe(false);
  });
  it.each([journalKey(), activeRestoreKey])("父回调成功后清理 %s 失败返回警告，重启仍保持已接受工程", failedKey => {
    const store = memory(fullSeed()), after = expectedAfter(new Map(store.data)), parent = vi.fn();
    const tx = prepareGitStorage(projectId, documents(), workspace(), store.storage, false, project()); tx.write(); tx.commit(); parent();
    expect(parent).toHaveBeenCalledTimes(1);
    vi.mocked(store.storage.removeItem).mockImplementation(key => { if (key === failedKey) throw new Error("清理权限不足"); store.data.delete(key); });
    let warning: string | undefined; expect(() => { warning = tx.finish(); }).not.toThrow();
    expect(warning).toEqual(expect.any(String)); expect(warning!.trim().length).toBeGreaterThan(0);
    const finished = store.snapshot(); tx.rollback(); expect(store.snapshot()).toEqual(finished);
    const restarted = memory([...store.data]); expect(recoverGitWorkspace(restarted.storage)).toEqual({ ...studioWorkspace(), project: project() });
    for (const [key, raw] of after) expect(restarted.data.get(key)).toBe(raw);
    expect(restarted.storage.setItem).not.toHaveBeenCalled(); expect(restarted.data.has(journalKey())).toBe(false); expect(restarted.data.has(activeRestoreKey)).toBe(false);
  });
  it.each(["prepared", "committed"])("recover 清理失败不抛且返回重读 workspace：%s", state => {
    const store = memory(fullSeed()), tx = prepareGitStorage(projectId, documents(), workspace(), store.storage, false, project());
    tx.write(); if (state === "committed") tx.commit();
    const restarted = memory([...store.data]);
    vi.mocked(restarted.storage.removeItem).mockImplementation(() => { throw new Error("清理被拒绝"); });
    let result: unknown; expect(() => { result = recoverGitWorkspace(restarted.storage); }).not.toThrow();
    expect(result).toEqual({ ...studioWorkspace(), project: project(projectId, state === "committed" ? "恢复" : "原稿") });
    expect(readJournal(restarted).state).toBe(state);
    if (state === "committed") expect(restarted.storage.setItem).not.toHaveBeenCalled();
    vi.mocked(restarted.storage.removeItem).mockImplementation(key => { restarted.data.delete(key); });
    expect(recoverGitWorkspace(restarted.storage)).toEqual(result); expect(restarted.data.has(journalKey())).toBe(false); expect(restarted.data.has(activeRestoreKey)).toBe(false);
  });
  it("committed 日志不得覆盖提交后其他窗口的最新值，清理不执行任何数据写入", () => {
    const store = memory(fullSeed()), tx = prepareGitStorage(projectId, documents(), workspace(), store.storage, false, project()); tx.write(); tx.commit();
    const foreign = studioWorkspace(project("foreign", "最新工程")); store.data.set(workspaceKey, JSON.stringify(foreign)); store.data.set(projectKey(), "foreign-project");
    const restarted = memory([...store.data]); expect(recoverGitWorkspace(restarted.storage)).toEqual(foreign);
    expect(restarted.data.get(projectKey())).toBe("foreign-project"); expect(restarted.storage.setItem).not.toHaveBeenCalled();
    expect(restarted.data.has(journalKey())).toBe(false); expect(restarted.data.has(activeRestoreKey)).toBe(false);
  });
});

describe("v2 日志权限与事务所有权保护", () => {
  it.each(["非法状态", "重复 key", "其他工程主 key", "其他工程附件", "全局品牌 key", "指针 key", "非字符串值", "空 entries"])("启动拒绝%s，不能改写或清理任何原数据", mode => {
    const store = memory(fullSeed()), tx = prepareGitStorage(projectId, documents(), workspace(), store.storage, false, project()); tx.write();
    const saved = readJournal(store);
    if (mode === "非法状态") saved.state = "finished";
    if (mode === "重复 key") saved.entries.push({ ...saved.entries[0]! });
    if (mode === "其他工程主 key") saved.entries[0]!.key = projectKey("foreign");
    if (mode === "其他工程附件") saved.entries[0]!.key = projectAssetsKey("foreign");
    if (mode === "全局品牌 key") saved.entries[0]!.key = BRAND_DRAFT_KEY;
    if (mode === "指针 key") saved.entries[0]!.key = activeRestoreKey;
    if (mode === "非字符串值") Object.assign(saved.entries[0]!, { before: 1 });
    if (mode === "空 entries") saved.entries = [];
    store.data.set(journalKey(), JSON.stringify(saved));
    const restarted = memory([...store.data]), before = restarted.snapshot();
    expect(() => recoverGitWorkspace(restarted.storage)).toThrow(/日志损坏/); expect(restarted.snapshot()).toEqual(before);
    expect(restarted.storage.setItem).not.toHaveBeenCalled(); expect(restarted.storage.removeItem).not.toHaveBeenCalled();
  });
  it("损坏 JSON 日志由启动恢复拒绝，不能吞掉错误或移除指针", () => {
    const store = memory(fullSeed()), tx = prepareGitStorage(projectId, documents(), workspace(), store.storage, false, project()); tx.write();
    store.data.set(journalKey(), "{"); const restarted = memory([...store.data]), before = restarted.snapshot();
    expect(() => recoverGitWorkspace(restarted.storage)).toThrow(/日志损坏/); expect(restarted.snapshot()).toEqual(before);
    expect(restarted.storage.setItem).not.toHaveBeenCalled(); expect(restarted.storage.removeItem).not.toHaveBeenCalled();
  });
  it.each(["commit", "rollback", "finish"] as const)("write 后日志被替换，%s 不得覆盖或删除 foreign 日志及数据", operation => {
    const store = memory(fullSeed()), tx = prepareGitStorage(projectId, documents(), workspace(), store.storage, false, project()); tx.write();
    if (operation === "finish") tx.commit();
    const replacement = v2Journal([{ key: projectDocumentsKey(projectId), before: "foreign-before", after: "foreign-after" }]);
    store.data.set(journalKey(), replacement); const before = store.snapshot(); vi.mocked(store.storage.setItem).mockClear(); vi.mocked(store.storage.removeItem).mockClear();
    if (operation === "finish") {
      let warning: string | undefined; expect(() => { warning = tx.finish(); }).not.toThrow(); expect(warning).toEqual(expect.any(String));
    } else expect(() => tx[operation]()).toThrow();
    expect(store.snapshot()).toEqual(before); expect(store.storage.setItem).not.toHaveBeenCalled(); expect(store.storage.removeItem).not.toHaveBeenCalled();
  });
  it.each(["prepared", "committed"])("恢复期间日志被替换不能删除替换者的日志：%s", state => {
    const store = memory(fullSeed()), tx = prepareGitStorage(projectId, documents(), workspace(), store.storage, false, project());
    tx.write(); if (state === "committed") tx.commit();
    const restarted = memory([...store.data]);
    const replacement = v2Journal([{ key: projectAssetsKey(projectId), before: null, after: "foreign" }]);
    let reads = 0;
    vi.mocked(restarted.storage.getItem).mockImplementation(key => {
      const raw = restarted.data.get(key) ?? null;
      if (key === journalKey() && ++reads === 1) restarted.data.set(key, replacement);
      return raw;
    });
    try { recoverGitWorkspace(restarted.storage); } catch { /* 冲突允许上报，但绝不删除新日志。 */ }
    expect(restarted.data.get(journalKey())).toBe(replacement);
    expect(restarted.storage.removeItem).not.toHaveBeenCalledWith(journalKey());
  });
  it("finish 不得移除其他工程替换的全局指针，已提交数据保持 after", () => {
    const store = memory(fullSeed()), tx = prepareGitStorage(projectId, documents(), workspace(), store.storage, false, project()); tx.write(); tx.commit();
    const foreignPointer = JSON.stringify({ projectId: "foreign" }); store.data.set(activeRestoreKey, foreignPointer);
    const after = transactionKeys().map(key => [key, store.data.get(key)]);
    vi.mocked(store.storage.removeItem).mockClear(); expect(() => tx.finish()).not.toThrow();
    expect(store.data.get(activeRestoreKey)).toBe(foreignPointer); expect(store.storage.removeItem).not.toHaveBeenCalledWith(activeRestoreKey);
    tx.rollback(); expect(transactionKeys().map(key => [key, store.data.get(key)])).toEqual(after);
  });
  it("prepare 后出现其他工程的活动指针，write 不得抢占全局事务", () => {
    const store = memory(fullSeed()), tx = prepareGitStorage(projectId, documents(), workspace(), store.storage, false, project());
    store.data.set(activeRestoreKey, JSON.stringify({ projectId: "foreign" })); const before = store.snapshot();
    expect(() => tx.write()).toThrow(); expect(store.snapshot()).toEqual(before); expect(store.storage.setItem).not.toHaveBeenCalled(); expect(store.storage.removeItem).not.toHaveBeenCalled();
  });
});

describe("recoverGitStorage 中断恢复与 foreign 保护", () => {
  it("recover 预检后其他窗口再更新尚未回退的 key，不得覆盖 foreign 新值", () => {
    const [scriptKey, designKey] = attachmentKeys() as [string, string, string, string];
    const store = memory([[scriptKey, "after-script"], [designKey, "after-design"]]);
    store.data.set(journalKey(), journal([{ key: scriptKey, before: "before-script", after: "after-script" }, { key: designKey, before: "before-design", after: "after-design" }]));
    vi.mocked(store.storage.setItem).mockImplementation((key, value) => {
      store.data.set(key, value); if (key === designKey) store.data.set(scriptKey, "foreign-after-preflight");
    });
    let error: unknown; try { recoverGitStorage(projectId, store.storage); } catch (cause) { error = cause; }
    expect(store.data.get(scriptKey)).toBe("foreign-after-preflight"); expect(store.data.has(journalKey())).toBe(true); expect(error).toBeInstanceOf(Error);
  });
  it("按逆序回退已写和未写 key，恢复 null，并且重复 recover 无副作用", () => {
    const store = memory([[attachmentKeys()[0]!, "new"], [attachmentKeys()[1]!, "before-design"]]);
    store.data.set(journalKey(), journal([{ key: attachmentKeys()[0]!, before: null, after: "new" }, { key: attachmentKeys()[1]!, before: "before-design", after: "after-design" }]));
    recoverGitStorage(projectId, store.storage); expect(store.data).toEqual(new Map([[attachmentKeys()[1]!, "before-design"]]));
    recoverGitStorage(projectId, store.storage); expect(store.storage.removeItem).toHaveBeenCalledTimes(2);
  });
  it("先预检全部 entry，发现后一个 foreign 时前一个已写值也不得被回退", () => {
    const store = memory([[attachmentKeys()[0]!, "after"], [attachmentKeys()[1]!, "foreign"]]);
    store.data.set(journalKey(), journal(attachmentKeys().slice(0, 2).map(key => ({ key, before: "before", after: "after" })))); const before = store.snapshot();
    expect(() => recoverGitStorage(projectId, store.storage)).toThrow(/其他窗口/); expect(store.snapshot()).toEqual(before); expect(store.storage.setItem).not.toHaveBeenCalled(); expect(store.storage.removeItem).not.toHaveBeenCalled();
  });
  it.each([
    "{", JSON.stringify({ version: 2, entries: [] }), journal([]),
    journal([{ key: "foreign-key", before: null, after: "x" }]),
    journal([{ key: attachmentKeys()[0]!, before: null, after: "x" }, { key: attachmentKeys()[0]!, before: null, after: "x" }]),
    JSON.stringify({ version: 1, entries: [{ key: attachmentKeys()[0], before: 1, after: "x" }] }),
  ])("损坏或越权 journal 不覆盖、不删除原数据：%s", raw => {
    const store = memory([...seed(), [journalKey(), raw]]), before = store.snapshot();
    expect(() => recoverGitStorage(projectId, store.storage)).toThrow(/日志损坏/); expect(store.snapshot()).toEqual(before); expect(store.storage.setItem).not.toHaveBeenCalled(); expect(store.storage.removeItem).not.toHaveBeenCalled();
  });
  it("capture 先恢复未 finish 的交易，再读取原稿", () => {
    const store = memory(seed()), tx = prepareGitStorage(projectId, documents(), workspace(), store.storage); tx.write();
    expect(captureProjectWorkspace(projectId, undefined, store.storage)).toEqual(workspace(projectId, "原稿")); expect(store.data.has(journalKey())).toBe(false);
  });
});

it("captures, restores and rolls back project canvas with the same Git transaction",()=>{
 const key=`glint:project-board:v1:${projectId}`, viewport=`glint:project-board:viewport:v1:${projectId}`;
 const store=memory([...seed(),[key,JSON.stringify({"scene:one":{x:30,y:40}})],[viewport,JSON.stringify({x:1,y:2,zoom:0.8})]]);
 const captured=captureProjectWorkspace(projectId,undefined,store.storage);
 expect(captured.board).toEqual({positions:{"scene:one":{x:30,y:40}},viewport:{x:1,y:2,zoom:0.8}});
 const changed={...captured,board:{positions:{"scene:one":{x:300,y:400}}}};
 const tx=prepareGitStorage(projectId,undefined,changed,store.storage);tx.write();
 expect(store.storage.getItem(viewport)).toBeNull();
 recoverGitStorage(projectId,store.storage);
 expect(captureProjectWorkspace(projectId,undefined,store.storage)).toEqual(captured);
 const next=prepareGitStorage(projectId,undefined,changed,store.storage);next.write();next.commit();next.finish();
 expect(captureProjectWorkspace(projectId,undefined,store.storage)).toEqual(changed);
});
it("does not export or overwrite corrupt canvas records",()=>{
 const key=`glint:project-board:v1:${projectId}`,store=memory([...seed(),[key,"broken"]]);
 expect(()=>captureProjectWorkspace(projectId,undefined,store.storage)).toThrow("画布");
 expect(()=>prepareGitStorage(projectId,undefined,workspace(),store.storage)).toThrow("画布");
 expect(store.storage.getItem(key)).toBe("broken");
});

it("preserves original workspace bytes when mount autosave adds only empty evidence",()=>{
 const original=JSON.stringify({project:project(),mode:"source",text:"Original",metadata:{keep:true}});
 const store=memory([[workspaceKey,original]]);
 expect(saveLocalWorkspace({mode:"source",text:"Original",project:project(),evidence:""},original,store.storage)).toBe(original);
 expect(store.storage.setItem).not.toHaveBeenCalled();
 expect(JSON.parse(saveLocalWorkspace({mode:"source",text:"Edited",project:project(),evidence:""},original,store.storage)).text).toBe("Edited");
});

function generationWorkspace(): ProjectWorkspace {
  const createdAt = "2026-11-01T00:00:00.000Z";
  return {...workspace(), generation: {canvas: {schemaVersion: 1, nodes: [{id:"image-1",kind:"image",prompt:"封面",model:"image-model",state:"running",outputAsset:"",error:"",createdAt,updatedAt:createdAt}],edges:[]}, positions:{"image-1":{x:12,y:34}}, viewport:{x:10,y:20,zoom:0.8}, receipts:{"image-1":{requestId:"request-1",nodeCreatedAt:createdAt,taskId:"task-1"}}}};
}
const generationKeys = () => [`glint:gen-canvas:v1:${projectId}`,`glint:gen-canvas:layout:v1:${projectId}`,`glint:gen-canvas:viewport:v1:${projectId}`,`glint:gen-canvas:receipt:${projectId}:image-1`];
function generationSeed(): [string,string][] {
  const generation=generationWorkspace().generation!;
  return generationKeys().map((key,index)=>[key,JSON.stringify([generation.canvas,generation.positions,generation.viewport,generation.receipts["image-1"]][index])]);
}
it("round trips generation DAG, layout, viewport and pending receipt in the durable transaction",()=>{
  const store=memory(seed()),original=store.snapshot();
  const tx=prepareGitStorage(projectId,undefined,generationWorkspace(),store.storage);tx.write();
  expect(captureProjectWorkspace(projectId,undefined,memory(store.snapshot().filter(([key])=>key!==journalKey())).storage)).toEqual(generationWorkspace());
  recoverGitStorage(projectId,store.storage);expect(store.snapshot()).toEqual(original);
  const accepted=prepareGitStorage(projectId,undefined,generationWorkspace(),store.storage);accepted.write();accepted.commit();accepted.finish();
  expect(captureProjectWorkspace(projectId,undefined,store.storage)).toEqual(generationWorkspace());
});
it("refuses removal of unresolved receipts and rewinding newer finalized tasks",()=>{
  const store=memory([...seed(),...generationSeed()]),before=store.snapshot();
  expect(()=>prepareGitStorage(projectId,undefined,workspace(),store.storage)).toThrow("待确认");expect(store.snapshot()).toEqual(before);
  const key=generationKeys()[3]!;
  store.data.set(key,JSON.stringify({...generationWorkspace().generation!.receipts["image-1"],isFinal:true}));
  expect(()=>prepareGitStorage(projectId,undefined,generationWorkspace(),store.storage)).toThrow("更新");
});
it("checks receipt ownership when restoring a copy and when delayed confirmation resumes",()=>{
  const key=generationKeys()[3]!,receipt=JSON.stringify(generationWorkspace().generation!.receipts["image-1"]);
  const collision=memory([[key,receipt]]);
  expect(()=>prepareGitStorage(projectId,undefined,generationWorkspace(),collision.storage,true)).toThrow("已存在");
  const store=memory([...fullSeed(),...generationSeed()]);
  const snapshot=readLocalGitVersion(projectId,store.storage);
  store.data.set(key,JSON.stringify({...JSON.parse(receipt),isFinal:true}));
  expect(()=>snapshot.assertCurrent()).toThrow("已变化");
});
it("detects a newly submitted receipt between preparing and writing a restore",()=>{
  const value=generationWorkspace();value.generation!.canvas.nodes[0]!.state="draft";value.generation!.receipts={};
  const store=memory([...seed(),[generationKeys()[0]!,JSON.stringify(value.generation!.canvas)]]);
  const tx=prepareGitStorage(projectId,undefined,workspace(),store.storage);
  store.data.set(generationKeys()[3]!,JSON.stringify(generationWorkspace().generation!.receipts["image-1"]));
  expect(()=>tx.write()).toThrow();expect(store.data.get(generationKeys()[0]!)).toBe(JSON.stringify(value.generation!.canvas));
});

it("round trips logical board groups through a committed Git restore and preserves foreign group bytes",()=>{
 const value=workspace();value.board={positions:{},groups:[{id:"group-one",title:"参考",members:["scene:one","script:one"]}]};
 const store=memory(seed()),key=`glint:project-board:groups:v1:${projectId}`;
 const tx=prepareGitStorage(projectId,undefined,value,store.storage);tx.write();tx.commit();tx.finish();
 expect(captureProjectWorkspace(projectId,undefined,store.storage).board).toEqual(value.board);
 const next=prepareGitStorage(projectId,undefined,workspace(),store.storage);store.data.set(key,'foreign');
 expect(()=>next.write()).toThrow();expect(store.data.get(key)).toBe('foreign');
});

function linkedTimeline(title="原剪辑"){
 const project=parseNleProject({schemaVersion:1,id:projectId,title,fps:30,width:1920,height:1080,tracks:[]});
 return{project,bridge:{projectId,sourceId:"saved-film",links:[]}};
}
function timelineRecord(title="原剪辑"){
 const {project,bridge}=linkedTimeline(title),session=createNleSession(project);
 return serializeNleRecord({project:JSON.stringify(project),session:JSON.stringify(session.exportState())},bridge);
}
it("captures the associated timeline and restores or rolls back its record with the whole workspace",()=>{
 const raw=timelineRecord(),key=nleRecordKey(projectId),store=memory([...seed(),[key,raw],["glint.nle.project.v2",JSON.stringify(linkedTimeline().project)],["glint.nle.session.v1",parseNleRecord(raw,projectId).pair.session!]]);
 expect(captureProjectWorkspace(projectId,undefined,store.storage).timeline).toEqual(linkedTimeline());
 const target={...workspace(),timeline:linkedTimeline("恢复剪辑")},tx=prepareGitStorage(projectId,documents(),target,store.storage);
 tx.write();expect(JSON.parse(parseNleRecord(store.data.get(key)!,projectId).pair.project!).title).toBe("恢复剪辑");
 // Active durable pair changes in the same WAL, so a restart cannot see mixed versions.
 expect(JSON.parse(store.data.get("glint.nle.project.v2")!).title).toBe("恢复剪辑");tx.rollback();expect(JSON.parse(store.data.get("glint.nle.project.v2")!).title).toBe("原剪辑");expect(store.data.get(key)).toBe(raw);
 const accepted=prepareGitStorage(projectId,documents(),target,store.storage);accepted.write();accepted.commit();accepted.finish();
 expect(captureProjectWorkspace(projectId,undefined,store.storage).timeline).toEqual(target.timeline);
 expect(JSON.parse(parseNleRecord(store.data.get(key)!,projectId).pair.session!).history).toEqual([]);
});
it("refuses malformed or in-flight associated timelines, detects restore races and retains them for old snapshots",()=>{
 const key=nleRecordKey(projectId),store=memory([...seed(),[key,timelineRecord()]]),before=store.data.get(key);
 const old=prepareGitStorage(projectId,documents(),workspace(),store.storage);old.write();old.commit();old.finish();expect(store.data.get(key)).toBe(before);
 const tx=prepareGitStorage(projectId,documents(),{...workspace(),timeline:linkedTimeline("新版本")},store.storage);
 store.data.set(key,timelineRecord("其他窗口"));expect(()=>tx.write()).toThrow("其他窗口");expect(JSON.parse(parseNleRecord(store.data.get(key)!,projectId).pair.project!).title).toBe("其他窗口");
 store.data.set(key,'{broken');expect(()=>captureProjectWorkspace(projectId,undefined,store.storage)).toThrow();
 store.data.set(key,timelineRecord());store.data.set("glint.nle.save.v1","pending");expect(()=>captureProjectWorkspace(projectId,undefined,store.storage)).toThrow("剪辑保存日志");
});

it.each(["glint.nle.project.v2","glint.nle.session.v1"])("rolls back the linked timeline when active pair write fails: %s",failedKey=>{
 const raw=timelineRecord(),record=parseNleRecord(raw,projectId),store=memory([...seed(),[nleRecordKey(projectId),raw],["glint.nle.project.v2",record.pair.project!],["glint.nle.session.v1",record.pair.session!]]),before=store.snapshot();
 const original=store.storage.setItem;let failed=false;vi.mocked(store.storage.setItem).mockImplementation((key,value)=>{if(key===failedKey&&!failed){failed=true;throw new Error("disk full");}store.data.set(key,value);});
 const tx=prepareGitStorage(projectId,documents(),{...workspace(),timeline:linkedTimeline("恢复失败")},store.storage);expect(()=>tx.write()).toThrow();expect(store.snapshot()).toEqual(before);
});
