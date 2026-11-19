import { afterEach, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { link, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseProjectWorkspace } from "@glintai/scenescript";
// @ts-expect-error native server module
import { createProjectGitHost } from "./project-git-host.mjs";
// @ts-expect-error native server module
import { createDesktopAgentControl } from "./desktop-agent-control.mjs";
// @ts-expect-error native server module
import { boundedJson, designHtmlFile, LIMITS, managedFile, mediaInfo, repositoryKey, textFiles, validateFiles } from "./project-git-files.mjs";

const exec = promisify(execFile);
const scene = { schemaVersion: 1, id: "demo", title: "Demo", aspect: "16:9", knowledgeSources: [],
  scenes: [{ id: "title", kind: "title", title: "Title", narration: { text: "Hello" } }] };
const document = { id: "../script; $(danger)", title: "剧本", kind: "screenplay", content: "第一幕\n你好\n", updatedAt: 1780000000123 };
const emptyWorkspace = () => ({ version: 1, projectId: "demo", designs: { version: 1, projectId: "demo", documents: [], activeId: "" }, brand: null, assets: [] });
const designWorkspace = () => ({ ...emptyWorkspace(), designs: { version: 1, projectId: "demo", activeId: "../设计;$(doc)", documents: [{
  id: "../设计;$(doc)", title: "设计", kind: "page", activePageId: "../../页面", updatedAt: 1780000000123,
  pages: [{ id: "../../页面", title: "首页", html: '<!doctype html><h1 data-node-id="hero">标题</h1><img src="data:image/png;base64,aGVsbG8=">', notes: "演示备注",
    annotations: [{ id: "mark", x: 25, y: 75, text: "保留此批注", nodeId: "hero", createdAt: 1780000000123 }] }],
}] }, brand: { name: "固定品牌", accent: "#e0533d", bg: "#0a0a0b", text: "#f4f1ea", logoText: "GLINT", displayFont: "Arial" },
  assets: [{ name: "reference.png", url: "/api/media/assets/reference.png", bytes: 512 * 1024 }] });
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const task of cleanup.splice(0).reverse()) await task(); });
async function setup(extra = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "glint-git-"));
  cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
  const host = createProjectGitHost({ dataDir, ...extra }); cleanup.push(() => host.dispose());
  const request = (operation: string, values = {}) => host.request({ action: "git", operation, projectId: "demo", kind: "scene", ...values });
  return { host, dataDir, request, root: path.join(dataDir, "projects", repositoryKey("demo", "scene")) };
}
async function committed(request: any, snapshot = scene, documents = [document]) {
  expect(await request("open", { snapshot, documents })).toMatchObject({ ok: true });
  const result = await request("commit", { message: "用户版本" });
  expect(result).toMatchObject({ ok: true, changedFiles: [] }); expect(result.version).toMatch(/^[a-f0-9]{40}$/); return result.version;
}
it("uses real commits and file text diff; dirty checkout refuses, discard restores JSON and document metadata", async () => {
  const { request, root } = await setup();
  expect(await request("open", { snapshot: scene, documents: [document] })).toMatchObject({ ok: true, current: null, versionCount: 0 });
  expect(await request("history")).toMatchObject({ ok: true, versions: [] });
  const first = await committed(request);
  const actual = await exec("git", [`--git-dir=${path.join(root, "repo.git")}`, "log", "-1", "--format=%an|%ae|%s"]);
  expect(actual.stdout.trim()).toBe("Glint Local|local@glint.invalid|用户版本");
  await request("open", { snapshot: { ...scene, title: "改动" }, documents: [{ ...document, content: "第二幕", updatedAt: 1780000000456 }] });
  const diff = await request("diff"); expect(diff.ok).toBe(true);
  expect(diff.files.find((item: any) => item.path === "project.json")).toMatchObject({ status: "modified", before: expect.stringContaining('"Demo"'), after: expect.stringContaining('"改动"') });
  expect(diff.files.find((item: any) => item.path.endsWith(".txt"))).toMatchObject({ before: document.content, after: "第二幕" });
  expect(await request("checkout", { version: first })).toMatchObject({ ok: false, error: { code: "dirty" } });
  expect(await request("discard")).toMatchObject({ ok: true, project: scene, documents: [document], version: first });
  expect(await request("status")).toMatchObject({ changedFiles: [] });
  expect(await request("commit")).toMatchObject({ ok: false, error: { code: "nothing" } });
}, 30000);

it("preserves Git graph across checkout/new commits, copy, logical delete/recover and host restart", async () => {
  const { request, host, dataDir, root } = await setup();
  const first = await committed(request), second = await committed(request, { ...scene, title: "Second" });
  const initialDiff = await request("diff", { version: first });
  expect(initialDiff.files.find((item: any) => item.path === "project.json")).toMatchObject({ status: "added", before: "" });
  expect(await request("checkout", { version: first })).toMatchObject({ ok: true, project: scene, documents: [document] });
  const third = await committed(request, { ...scene, title: "Third" });
  const all = await request("history", { includeDeleted: true });
  expect(all.versions.map((item: any) => item.id).sort()).toEqual([first, second, third].sort());
  expect(all.versions.find((item: any) => item.id === third)).toMatchObject({ parent: first, current: true, deleted: false, at: expect.any(Number) });
  expect(await request("deleteVersions", { versions: [third] })).toMatchObject({ ok: false, error: { code: "current-version" } });
  expect(await request("deleteVersions", { versions: [second] })).toMatchObject({ ok: true });
  expect((await request("history")).versions.map((item: any) => item.id)).not.toContain(second);
  expect((await request("history", { deleted: true })).versions).toMatchObject([{ id: second, deleted: true }]);
  const copy = await request("copy", { version: second });
  expect(copy).toMatchObject({ ok: true, project: { title: "Second" }, documents: [document], version: second });
  expect(copy.projectId).not.toBe("demo"); expect(copy.project.id).toBe(copy.projectId);
  expect(await request("status")).toMatchObject({ current: third, changedFiles: [], versionCount: 3 });
  await exec("git", [`--git-dir=${path.join(root, "repo.git")}`, "cat-file", "-e", `${second}^{commit}`]);
  await host.dispose();
  const reopened = createProjectGitHost({ dataDir }); cleanup.push(() => reopened.dispose());
  const call = (operation: string, values = {}) => reopened.request({ action: "git", operation, projectId: "demo", kind: "scene", ...values });
  expect((await call("history", { deleted: true })).versions).toMatchObject([{ id: second, deleted: true }]);
  expect(await call("recoverVersions", { versions: [second] })).toMatchObject({ ok: true });
  expect(await call("checkout", { version: second })).toMatchObject({ ok: true, project: { title: "Second" }, documents: [document] });
}, 30000);

it("serializes project requests, validates kinds/ids/limits, and stores NLE media references without copying assets", async () => {
  const { host, request, dataDir } = await setup();
  const first = request("open", { snapshot: scene, documents: [document] });
  const second = request("commit", { message: "第一版" });
  expect((await Promise.all([first, second])).every(item => item.ok)).toBe(true);
  expect(await request("open", { snapshot: { ...scene, id: "other" } })).toMatchObject({ ok: false, error: { code: "project-id" } });
  expect(await request("open", { snapshot: scene, documents: [document, document] })).toMatchObject({ ok: false, error: { code: "invalid-documents" } });
  expect(await request("open", { snapshot: scene, documents: [{ ...document, updatedAt: "yesterday" }] })).toMatchObject({ ok: false, error: { code: "invalid-documents" } });
  expect(await request("open", { snapshot: scene, documents: [{ ...document, content: "x".repeat(300000) }] })).toMatchObject({ ok: false, error: { code: "invalid-documents" } });
  expect(await request("checkout", { version: "--help" })).toMatchObject({ ok: false, error: { code: "invalid-version" } });
  expect(await request("push")).toMatchObject({ ok: false, error: { code: "invalid-request" } });
  const snapshot = { schemaVersion: 1, id: "demo", title: "NLE", fps: 30, width: 1280, height: 720,
    tracks: [{ id: "video", kind: "video", name: "画面", clips: [{ id: "clip", kind: "video", src: "assets/local.mp4", startMs: 0, durationMs: 1000 }] }] };
  const call = (operation: string, values = {}) => host.request({ action: "git", operation, projectId: "demo", kind: "nle", ...values });
  expect(await call("open", { snapshot, documents: [document] })).toMatchObject({ ok: true, mediaRefs: ["assets/local.mp4"], mediaPolicy: expect.stringContaining("不复制") });
  const saved = await call("commit"); expect(saved.ok).toBe(true);
  expect(await call("copy", { version: saved.version })).toMatchObject({ ok: true, project: { tracks: snapshot.tracks }, documents: [document] });
  const work = path.join(dataDir, "projects", repositoryKey("demo", "nle"), "work");
  expect((await readdir(work)).sort()).toEqual(["documents", "documents.json", "project.json"]);
}, 30000);

it("共享校验器从 scenescript 导出且接受完整工作区契约", () => {
  expect(parseProjectWorkspace).toBeTypeOf("function");
  expect(parseProjectWorkspace(designWorkspace(), "demo")).toEqual(designWorkspace());
  expect(parseProjectWorkspace(emptyWorkspace(), "demo")).toEqual(emptyWorkspace());
});

it("往返保存含批注和内嵌图片的设计、固定品牌和素材引用，支持 diff、恢复、放弃、复制及重启", async () => {
  const { request, root, host, dataDir } = await setup();
  const workspace = designWorkspace(), page = workspace.designs.documents[0]!.pages[0]!;
  Object.assign(workspace, { board: { positions: { "scene:one": { x: 40, y: 80 } }, viewport: { x: 10, y: -20, zoom: 0.8 } } });
  const htmlFile = designHtmlFile(workspace.designs.documents[0]!.id, page.id);
  expect(await request("open", { snapshot: scene, documents: [document], workspace })).toMatchObject({ ok: true, mediaRefs: [workspace.assets[0]!.url] });
  const first = await request("commit", { message: "设计初版" }); expect(first, JSON.stringify(first)).toMatchObject({ ok: true });
  const metadata = JSON.parse(await readFile(path.join(root, "work", "workspace.json"), "utf8"));
  expect(metadata.designs.documents[0].pages[0]).toEqual({ id: page.id, title: page.title, notes: page.notes, annotations: page.annotations, htmlFile });
  expect(await readFile(path.join(root, "work", htmlFile), "utf8")).toBe(page.html);
  const tree = await exec("git", [`--git-dir=${path.join(root, "repo.git")}`, "ls-tree", "-r", "--name-only", first.version]);
  expect(tree.stdout.trim().split("\n").sort()).toEqual([...textFiles(scene, [document], workspace).keys()].sort());
  expect(tree.stdout).not.toContain("reference.png");
  const next = structuredClone(workspace); next.designs.documents[0]!.pages[0]!.html += "<p>新版</p>";
  next.designs.documents[0]!.pages[0]!.annotations[0]!.text = "新批注"; next.brand.name = "新版品牌";
  next.assets = [{ name: "new.png", url: "/api/media/assets/new.png", bytes: 12 }];
  expect(await request("open", { workspace: next })).toMatchObject({ ok: true });
  const diff = await request("diff");
  expect(diff.files.map((file: any) => file.path).sort()).toEqual([htmlFile, "workspace.json"].sort());
  expect(diff.files.find((file: any) => file.path === htmlFile)).toMatchObject({ before: page.html, after: next.designs.documents[0]!.pages[0]!.html });
  expect(await request("discard")).toMatchObject({ ok: true, workspace });
  const second = await request("commit", { workspace: next, message: "设计新版" }); expect(second.ok).toBe(true);
  expect(await request("checkout", { version: first.version })).toMatchObject({ ok: true, workspace });
  expect(await request("checkout", { version: second.version })).toMatchObject({ ok: true, workspace: next });
  const copy = await request("copy", { version: first.version });
  expect(copy.ok).toBe(true); expect(copy.projectId).not.toBe("demo");
  expect(copy.project.id).toBe(copy.projectId); expect(copy.workspace.projectId).toBe(copy.projectId);
  expect(copy.workspace.designs.projectId).toBe(copy.projectId);
  expect(copy.workspace).toEqual({ ...workspace, projectId: copy.projectId, designs: { ...workspace.designs, projectId: copy.projectId } });
  for (const word of ["设计", "批注", "内嵌图片", "固定品牌", "素材引用", "不备份共享素材原文件"]) expect(copy.mediaPolicy).toContain(word);
  await host.dispose();
  const reopened = createProjectGitHost({ dataDir }); cleanup.push(() => reopened.dispose());
  const call = (operation: string, values = {}) => reopened.request({ action: "git", operation, projectId: "demo", kind: "scene", ...values });
  expect(await call("status")).toMatchObject({ ok: true, current: second.version, changedFiles: [], mediaRefs: [next.assets[0]!.url] });
  expect(await call("discard")).toMatchObject({ ok: true, workspace: next });
  expect(await call("checkout", { version: first.version })).toMatchObject({ ok: true, workspace });
}, 60000);

it("兼容 legacy 无工作区，省略保留工作区，显式空工作区清空且可版本化", async () => {
  const { request, root } = await setup();
  const legacy = await committed(request);
  expect(await request("copy", { version: legacy })).not.toHaveProperty("workspace");
  expect(await request("open", { snapshot: { ...scene, title: "旧式请求" } })).toMatchObject({ ok: true });
  await expect(readFile(path.join(root, "work", "workspace.json"))).rejects.toMatchObject({ code: "ENOENT" });
  const workspace = designWorkspace();
  expect(await request("commit", { workspace })).toMatchObject({ ok: true });
  expect(await request("commit", { snapshot: scene, documents: [document] })).toMatchObject({ ok: true });
  expect(await request("discard")).toMatchObject({ ok: true, workspace });
  expect(await request("open", { workspace: emptyWorkspace() })).toMatchObject({ ok: true });
  const diff = await request("diff");
  expect(diff.files.some((file: any) => file.path.endsWith(".html") && file.status === "deleted")).toBe(true);
  const empty = await request("commit"); expect(empty.ok).toBe(true);
  expect(await request("discard")).toMatchObject({ ok: true, workspace: emptyWorkspace() });
  expect(await request("checkout", { version: legacy })).not.toHaveProperty("workspace");
  expect(await request("checkout", { version: empty.version })).toMatchObject({ ok: true, workspace: emptyWorkspace() });
}, 60000);

it("坏工作区字段、数量和字节上限在写入前拒绝，不半更新工程或剧本", async () => {
  const { request, root } = await setup();
  const workspace = designWorkspace(); expect(await request("open", { snapshot: scene, documents: [document], workspace })).toMatchObject({ ok: true });
  const saved = await request("commit"); expect(saved.ok).toBe(true);
  const originals = textFiles(scene, [document], workspace);
  for (const file of originals.keys()) originals.set(file, await readFile(path.join(root, "work", file), "utf8"));
  const bad: any[] = [null, {}, { ...workspace, unexpected: true }, { ...workspace, projectId: "foreign" },
    { ...workspace, designs: { ...workspace.designs, projectId: "foreign" } }, { ...workspace, brand: { ...workspace.brand, token: "secret" } },
    { ...workspace, assets: [{ ...workspace.assets[0], bytes: 512 * 1024 + 1 }] },
    { ...workspace, assets: Array.from({ length: 41 }, (_, index) => ({ name: `${index}.png`, url: `/api/media/assets/${index}.png`, bytes: 1 })) },
    { ...workspace, assets: [{ ...workspace.assets[0], extra: true }] },
    { ...workspace, assets: [{ ...workspace.assets[0], url: "../../private.png" }] },
    { ...workspace, assets: [{ ...workspace.assets[0], bytes: -1 }] }];
  for (const key of ["version", "projectId", "designs", "brand", "assets"]) { const value: any = structuredClone(workspace); delete value[key]; bad.push(value); }
  const pageField = structuredClone(workspace) as any; pageField.designs.documents[0].pages[0].extra = true; bad.push(pageField);
  const annotation = structuredClone(workspace) as any; annotation.designs.documents[0].pages[0].annotations[0].x = 101; bad.push(annotation);
  const html = structuredClone(workspace); html.designs.documents[0]!.pages[0]!.html = "界".repeat(Math.floor(LIMITS.html / 3) + 1); bad.push(html);
  const docs = structuredClone(workspace); docs.designs.documents = Array.from({ length: 33 }, (_, index) => ({ ...docs.designs.documents[0]!, id: `doc${index}` })); docs.designs.activeId = "doc0"; bad.push(docs);
  const pages = structuredClone(workspace); pages.designs.documents[0]!.pages = Array.from({ length: 101 }, (_, index) => ({ ...pages.designs.documents[0]!.pages[0]!, id: `page${index}` })); pages.designs.documents[0]!.activePageId = "page0"; bad.push(pages);
  for (const value of bad) {
    expect(await request("open", { snapshot: { ...scene, title: "不应写入" }, documents: [], workspace: value })).toMatchObject({ ok: false });
    for (const [file, content] of originals) expect(await readFile(path.join(root, "work", file), "utf8")).toBe(content);
  }
  expect(await request("commit", { snapshot: { ...scene, title: "不应写入" }, workspace, message: "\0" })).toMatchObject({ ok: false, error: { code: "invalid-message" } });
  expect(await request("status")).toMatchObject({ ok: true, current: saved.version, changedFiles: [] });
}, 60000);

it.each(["缺 HTML", "路径替换", "非法字段", "metadata 内嵌 HTML"])("真实 Git 坏版本 %s 被恢复、复制及 diff 拒绝，工作副本和 HEAD 不变", async mode => {
  const { request, root } = await setup();
  const workspace = designWorkspace(), files = textFiles(scene, [document], workspace);
  expect(await request("open", { snapshot: scene, documents: [document], workspace })).toMatchObject({ ok: true });
  const saved = await request("commit"); expect(saved.ok).toBe(true);
  for (const file of files.keys()) files.set(file, await readFile(path.join(root, "work", file), "utf8"));
  const htmlFile = designHtmlFile(workspace.designs.documents[0]!.id, workspace.designs.documents[0]!.pages[0]!.id);
  const metadata = JSON.parse(files.get("workspace.json"));
  if (mode === "缺 HTML") await rm(path.join(root, "work", htmlFile));
  else {
    if (mode === "路径替换") metadata.designs.documents[0].pages[0].htmlFile = "../../outside.html";
    if (mode === "非法字段") metadata.brand.extra = "不允许";
    if (mode === "metadata 内嵌 HTML") metadata.designs.documents[0].pages[0].html = "偷偷替换";
    await writeFile(path.join(root, "work", "workspace.json"), JSON.stringify(metadata));
  }
  const changedProject = { ...scene, title: "不得半更新" };
  expect(await request("open", { snapshot: changedProject })).toMatchObject({ ok: false, error: { code: "invalid-workspace" } });
  expect(await readFile(path.join(root, "work", "project.json"), "utf8")).toBe(files.get("project.json"));
  const args = ["-c", "core.longpaths=true", `--git-dir=${path.join(root, "repo.git")}`, `--work-tree=${path.join(root, "work")}`];
  const env = { ...process.env, GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@glint.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@glint.invalid" };
  await exec("git", [...args, "add", "-A"], { env });
  const tree = (await exec("git", [...args, "write-tree"], { env })).stdout.trim();
  const broken = (await exec("git", [...args, "commit-tree", tree, "-p", saved.version, "-m", "损坏测试版本"], { env })).stdout.trim();
  await exec("git", [...args, "update-ref", `refs/glint/versions/${broken}`, broken], { env });
  for (const [file, content] of files) await writeFile(path.join(root, "work", file), content);
  await exec("git", [...args, "read-tree", saved.version], { env });
  for (const operation of ["checkout", "copy", "diff"]) {
    expect(await request(operation, { version: broken })).toMatchObject({ ok: false, error: { code: "invalid-workspace" } });
    expect((await exec("git", [...args, "rev-parse", "HEAD"], { env })).stdout.trim()).toBe(saved.version);
    for (const [file, content] of files) expect(await readFile(path.join(root, "work", file), "utf8")).toBe(content);
  }
  await exec("git", [...args, "update-ref", "HEAD", broken], { env });
  expect(await request("discard")).toMatchObject({ ok: false, error: { code: "invalid-workspace" } });
  for (const [file, content] of files) expect(await readFile(path.join(root, "work", file), "utf8")).toBe(content);
}, 60000);

it("闭合路径白名单、167 文件和总字节边界，以及 native 输入输出边界", () => {
  const workspace = designWorkspace();
  expect(mediaInfo({ nested: { src: workspace.assets[0]!.url, posterSrc: "media/poster.png" } }, workspace).mediaRefs)
    .toEqual([workspace.assets[0]!.url, "media/poster.png"].sort());
  for (const file of ["project.json", "documents.json", "workspace.json", `documents/${"a".repeat(64)}.txt`, `designs/${"b".repeat(64)}/${"c".repeat(64)}.html`]) expect(managedFile(file)).toBe(true);
  for (const file of ["../workspace.json", "designs/a/b.html", `designs/${"a".repeat(64)}/../x.html`, "designs/.git/config", "workspace.json/extra", "assets/a.png", "designs/a.html", "project.json\n"]) expect(managedFile(file)).toBe(false);
  const files = new Map<string, string>();
  for (let index = 0; index < LIMITS.files; index++) files.set(`designs/${"a".repeat(64)}/${index.toString(16).padStart(64, "0")}.html`, "");
  expect(() => validateFiles(files)).not.toThrow();
  files.set("project.json", "{}"); expect(() => validateFiles(files)).toThrow();
  const large = new Map(Array.from({ length: 5 }, (_, index) => [`designs/${"a".repeat(64)}/${index.toString(16).padStart(64, "0")}.html`, "x".repeat(LIMITS.html)]));
  expect(() => validateFiles(large)).not.toThrow();
  large.set("workspace.json", " "); expect(() => validateFiles(large)).toThrow();
  expect(() => boundedJson("x".repeat(LIMITS.input - 2))).not.toThrow();
  expect(() => boundedJson("x".repeat(LIMITS.input - 1))).toThrow();
  expect(() => boundedJson("x".repeat(LIMITS.output - 2), LIMITS.output)).not.toThrow();
  expect(() => boundedJson("x".repeat(LIMITS.output - 1), LIMITS.output)).toThrow();
});

it("真实 Git 接受 32 设计、总 100 页和 64 剧本文档共 167 文件，并拒绝超大 native 请求且保留 working", async () => {
  const { request } = await setup();
  const workspace: any = emptyWorkspace();
  workspace.designs.documents = Array.from({ length: 32 }, (_, docIndex) => ({ id: `doc${docIndex}`, title: "设计", kind: "page", updatedAt: 1, activePageId: "page0",
    pages: Array.from({ length: docIndex === 0 ? 69 : 1 }, (_, pageIndex) => ({ id: `page${pageIndex}`, title: "页面", html: "<p>设计</p>" })) }));
  workspace.designs.activeId = "doc0";
  const documents = Array.from({ length: 64 }, (_, index) => ({ ...document, id: `script${index}` }));
  expect(await request("open", { snapshot: scene, documents, workspace })).toMatchObject({ ok: true, changedFiles: expect.any(Array) });
  const saved = await request("commit"); expect(saved).toMatchObject({ ok: true, changedFiles: [] });
  const diff = await request("diff", { version: saved.version }); expect(diff.ok).toBe(true); expect(diff.files).toHaveLength(167);
  const copy = await request("copy", { version: saved.version }); expect(copy.ok).toBe(true);
  expect(copy.workspace.designs.documents).toHaveLength(32); expect(copy.documents).toHaveLength(64);
  expect(await request("open", { snapshot: scene, workspace, padding: "x".repeat(LIMITS.input) })).toMatchObject({ ok: false, error: { code: "too-large" } });
  expect(await request("status")).toMatchObject({ ok: true, current: saved.version, changedFiles: [] });
}, 120000);

it("按 UTF-8 字节接受单页 1MiB、workspace 2MiB 和 40 素材上界，超限不更新", async () => {
  const { request } = await setup();
  const workspace = designWorkspace();
  const first = workspace.designs.documents[0]!.pages[0]!;
  first.html = "x".repeat(LIMITS.html);
  workspace.assets = Array.from({ length: 40 }, (_, index) => ({ name: `${index}.png`, url: `/api/media/assets/${index}.png`, bytes: 512 * 1024 }));
  const second = { ...structuredClone(first), id: "second", html: "" }; workspace.designs.documents[0]!.pages.push(second);
  const remaining = LIMITS.workspace - Buffer.byteLength(JSON.stringify(workspace)); second.html = "y".repeat(remaining);
  expect(Buffer.byteLength(JSON.stringify(workspace))).toBe(LIMITS.workspace);
  expect(await request("open", { snapshot: scene, workspace })).toMatchObject({ ok: true });
  const saved = await request("commit"); expect(saved.ok).toBe(true);
  second.html += "y";
  expect(await request("open", { workspace })).toMatchObject({ ok: false, error: { code: "too-large" } });
  second.html = ""; first.html += "x";
  expect(await request("open", { workspace })).toMatchObject({ ok: false, error: { code: "invalid-workspace" } });
  expect(await request("status")).toMatchObject({ ok: true, current: saved.version, changedFiles: [] });
}, 60000);

it("省略字段合并后的快照仍受 4MiB 限制，不允许多次小请求累积绕过", async () => {
  const { request } = await setup();
  const workspace = designWorkspace(); workspace.designs.documents[0]!.pages[0]!.html = "x".repeat(LIMITS.html);
  expect(await request("open", { snapshot: scene, workspace })).toMatchObject({ ok: true });
  const saved = await request("commit"); expect(saved.ok).toBe(true);
  const documents = Array.from({ length: 13 }, (_, index) => ({ ...document, id: `script${index}`, content: "x".repeat(LIMITS.text) }));
  expect(await request("open", { documents })).toMatchObject({ ok: false, error: { code: "too-large" } });
  expect(await request("status")).toMatchObject({ ok: true, current: saved.version, changedFiles: [] });
}, 60000);

it.each(["多余 HTML", "缺 workspace 元数据", "超过文件上限", "超过版本总字节"])("真实 Git 拒绝 %s，恢复前不更改 working", async mode => {
  const { request, root } = await setup();
  const workspace = designWorkspace(); expect(await request("open", { snapshot: scene, workspace })).toMatchObject({ ok: true });
  const saved = await request("commit"); expect(saved.ok).toBe(true);
  const originals = textFiles(scene, [], workspace), extras: string[] = [];
  for (const file of originals.keys()) originals.set(file, await readFile(path.join(root, "work", file), "utf8"));
  if (mode === "缺 workspace 元数据") await rm(path.join(root, "work", "workspace.json"));
  else {
    const count = mode === "超过文件上限" ? 168 : mode === "超过版本总字节" ? 6 : 1;
    for (let index = 0; index < count; index++) {
      const file = `designs/${"a".repeat(64)}/${index.toString(16).padStart(64, "0")}.html`; extras.push(file);
      await mkdir(path.dirname(path.join(root, "work", file)), { recursive: true });
      await writeFile(path.join(root, "work", file), mode === "超过版本总字节" ? "x".repeat(LIMITS.html) : "孤立文件");
    }
  }
  const args = ["-c", "core.longpaths=true", `--git-dir=${path.join(root, "repo.git")}`, `--work-tree=${path.join(root, "work")}`];
  const env = { ...process.env, GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@glint.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@glint.invalid" };
  await exec("git", [...args, "add", "-A"], { env });
  const tree = (await exec("git", [...args, "write-tree"], { env })).stdout.trim();
  const broken = (await exec("git", [...args, "commit-tree", tree, "-p", saved.version, "-m", "越界测试版本"], { env })).stdout.trim();
  await exec("git", [...args, "update-ref", `refs/glint/versions/${broken}`, broken], { env });
  for (const file of extras) await rm(path.join(root, "work", file));
  for (const [file, content] of originals) await writeFile(path.join(root, "work", file), content);
  await exec("git", [...args, "read-tree", saved.version], { env });
  const code = mode === "超过版本总字节" ? "too-large" : "invalid-version";
  expect(await request("checkout", { version: broken })).toMatchObject({ ok: false, error: { code } });
  for (const [file, content] of originals) expect(await readFile(path.join(root, "work", file), "utf8")).toBe(content);
  expect(await request("status")).toMatchObject({ ok: true, current: saved.version, changedFiles: [] });
}, 60000);

it("拒绝嵌套设计目录链接、硬链接及白名单外目录", async () => {
  const { request, root, dataDir } = await setup();
  const workspace = designWorkspace(); expect(await request("open", { snapshot: scene, workspace })).toMatchObject({ ok: true });
  const htmlFile = designHtmlFile(workspace.designs.documents[0]!.id, workspace.designs.documents[0]!.pages[0]!.id);
  const folder = path.dirname(path.join(root, "work", htmlFile)), external = path.join(dataDir, "external");
  await mkdir(external); await writeFile(path.join(external, "sentinel"), "不可触碰");
  await rm(folder, { recursive: true }); await symlink(external, folder, process.platform === "win32" ? "junction" : "dir");
  expect(await request("status")).toMatchObject({ ok: false, error: { code: "unsafe-path" } });
  expect(await readFile(path.join(external, "sentinel"), "utf8")).toBe("不可触碰");
  await rm(folder); await mkdir(folder);
  await link(path.join(external, "sentinel"), path.join(root, "work", htmlFile));
  expect(await request("status")).toMatchObject({ ok: false, error: { code: "unsafe-path" } });
  await rm(path.join(root, "work", htmlFile)); await writeFile(path.join(root, "work", htmlFile), workspace.designs.documents[0]!.pages[0]!.html);
  await mkdir(path.join(root, "work", "designs", "raw-id"));
  expect(await request("status")).toMatchObject({ ok: false, error: { code: "unsafe-repository" } });
}, 30000);

it("桌面 native 分流保留完整 workspace 且不加载智能体，关闭和重启后仍可恢复", async () => {
  const { dataDir } = await setup();
  let created = 0, forwarded = 0, disposed = 0;
  const createHost = () => { created++; return { request: async (value: any) => { forwarded++; return { ok: true, action: value.action }; }, dispose: async () => { disposed++; } }; };
  const control = createDesktopAgentControl({ dataDir, createHost }); cleanup.push(() => control.dispose());
  const call = (operation: string, values = {}) => control.request({ action: "git", operation, projectId: "demo", kind: "scene", ...values });
  expect(await readdir(dataDir)).toEqual([]);
  const workspace = designWorkspace();
  expect(await call("open", { snapshot: scene, documents: [document], workspace })).toMatchObject({ ok: true });
  const saved = await call("commit", { message: "桌面设计版本" }); expect(saved.ok).toBe(true);
  expect(created).toBe(0); expect(forwarded).toBe(0);
  expect(await call("open", { workspace: emptyWorkspace() })).toMatchObject({ ok: true });
  expect(await call("discard")).toMatchObject({ ok: true, workspace, documents: [document] });
  expect(await control.request({ action: "list" })).toEqual({ ok: true, action: "list" });
  expect(created).toBe(1); expect(forwarded).toBe(1);
  await control.dispose(); expect(disposed).toBe(1);
  await expect(call("status")).rejects.toThrow("关闭");
  const reopened = createDesktopAgentControl({ dataDir, createHost }); cleanup.push(() => reopened.dispose());
  expect(await reopened.request({ action: "git", operation: "discard", projectId: "demo", kind: "scene" })).toMatchObject({ ok: true, version: saved.version, workspace });
  expect(created).toBe(1);
}, 30000);

it("reports missing Git and rejects foreign repository/config without touching a user repo", async () => {
  const { host, request, root, dataDir } = await setup();
  const missing = createProjectGitHost({ dataDir: path.join(dataDir, "missing"), gitPath: path.join(dataDir, "absent-git.exe") }); cleanup.push(() => missing.dispose());
  expect(await missing.request({ action: "git", operation: "open", projectId: "demo", kind: "scene", snapshot: scene })).toMatchObject({ ok: false, error: { code: "git-missing", message: expect.stringContaining("安装 Git") } });
  const userRepo = path.join(dataDir, "user"); await mkdir(userRepo); await exec("git", ["init", "--quiet", userRepo]);
  const config = await readFile(path.join(userRepo, ".git", "config"), "utf8");
  await committed(request);
  const sentinel = path.join(dataDir, "hook-ran");
  await writeFile(path.join(root, "repo.git", "config"), `[core]\nfsmonitor = touch ${sentinel}\n[include]\npath = ${path.join(userRepo, ".git", "config")}\n`);
  expect(await request("status")).toMatchObject({ ok: false, error: { code: "unsafe-repository" } });
  expect(await readFile(path.join(userRepo, ".git", "config"), "utf8")).toBe(config);
  await expect(readFile(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
  await host.dispose(); expect(await request("status")).toMatchObject({ ok: false, error: { code: "disposed" } });
}, 30000);

it("commits and copies the linked timeline with a new project identity and its media references",async()=>{
 const {request}=await setup();
 const workspace={...emptyWorkspace(),timeline:{project:{schemaVersion:1,id:"demo",title:"关联剪辑",fps:30,width:1920,height:1080,tracks:[{id:"v",kind:"video",name:"画面",clips:[{id:"shot",kind:"image",src:"assets/timeline-only.png",startMs:0,durationMs:1000}]}]},bridge:{projectId:"demo",sourceId:"saved-film",links:[]}}};
 expect(await request("open",{snapshot:scene,workspace})).toMatchObject({ok:true,mediaRefs:expect.arrayContaining(["assets/timeline-only.png"])});
 const saved=await request("commit",{message:"关联剪辑"});expect(saved.ok).toBe(true);
 const copy=await request("copy",{version:saved.version});expect(copy.ok).toBe(true);expect(copy.workspace.timeline.project.id).toBe(copy.projectId);expect(copy.workspace.timeline.bridge.projectId).toBe(copy.projectId);expect(copy.workspace.timeline.project.tracks).toEqual(workspace.timeline.project.tracks);
},30000);
