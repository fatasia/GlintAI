import {copyProjectWorkspace} from "@glintai/scenescript";
import { randomUUID } from "node:crypto";
import { lstat, opendir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createGitProcess, OWN_CONFIG } from "./project-git-process.mjs";
import { atomicJson, boundedJson, checkTree, demand, directory, exists, hash, LIMITS, managedFile, mediaInfo,
  fileLimit, parseDocuments, parseSnapshot, parseWorkspace, ProjectGitError, readText, recoverWork, replaceWork, repositoryKey,
  textFiles, unpackWorkspace, validateFiles } from "./project-git-files.mjs";

const OPERATIONS = new Set(["open", "status", "diff", "history", "commit", "checkout", "discard", "copy", "deleteVersions", "recoverVersions"]);
const statusOf = (before, after, file) => !before.has(file) ? "added" : !after.has(file) ? "deleted" : "modified";
const changed = (before, after) => [...new Set([...before.keys(), ...after.keys()])].sort()
  .filter(file => before.get(file) !== after.get(file)).map(file => ({ path: file, status: statusOf(before, after, file) }));

/** Private native host: no arbitrary repository path, commands, remotes, or implicit commits. */
export function createProjectGitHost({ dataDir, mediaRoot, gitPath } = {}) {
  demand(typeof dataDir === "string" && dataDir.length > 0, "invalid-directory", "版本服务需要本地数据目录。");
  const base = path.resolve(dataDir), git = createGitProcess(gitPath), locks = new Map();
  let disposed = false, pending = 0;
  async function ready(input) {
    await directory(base); await directory(path.join(base, "projects"));
    const key = repositoryKey(input.projectId, input.kind), root = path.join(base, "projects", key);
    await directory(root); await checkTree(root);
    const marker = path.join(root, "owner.json"), identity = { format: 1, projectId: input.projectId, kind: input.kind };
    if (await exists(marker)) demand(await readText(marker, 2048) === JSON.stringify(identity), "unsafe-repository", "版本目录不属于当前工程，已停止操作。");
    else {
      demand((await readdir(root)).length === 0, "unsafe-repository", "版本目录并非 Glint 创建，已停止操作。");
      await atomicJson(marker, identity);
    }
    await directory(path.join(root, "empty"));
    demand((await readdir(path.join(root, "empty"))).length === 0, "unsafe-repository", "版本隔离目录已被修改，已停止操作。");
    await recoverWork(root); await directory(path.join(root, "work"));
    if (!await exists(path.join(root, "repo.git"))) {
      await git.run(root, ["init", "--bare", "--object-format=sha1", "--initial-branch=main", `--template=${path.join(root, "empty")}`, path.join(root, "repo.git")], { initialize: true });
      await writeFile(path.join(root, "repo.git", "config"), OWN_CONFIG, { mode: 0o600 });
    }
    return root;
  }
  const run = (root, args, options) => git.run(root, ["-c", "core.longpaths=true", ...args], options);
  const head = async root => (await run(root, ["rev-parse", "--verify", "HEAD"], { allowMissing: true })).trim() || null;
  async function working(root) {
    const work = path.join(root, "work"), files = new Map();
    let entries = 0, bytes = 0;
    async function visit(prefix = "") {
      const folder = path.join(work, prefix), stat = await lstat(folder);
      demand(stat.isDirectory() && !stat.isSymbolicLink(), "unsafe-path", "版本目录不能是链接或普通文件。");
      for await (const item of await opendir(folder)) {
        demand(++entries <= LIMITS.files + 34, "too-large", "版本目录文件过多，已停止操作。");
        const file = prefix ? `${prefix}/${item.name}` : item.name;
        if (file === "documents" || file === "designs" || /^designs\/[a-f0-9]{64}$/.test(file)) await visit(file);
        else {
          demand(managedFile(file), "unsafe-repository", "版本目录含非工程文件，已停止操作。");
          const text = await readText(path.join(work, file), fileLimit(file)); bytes += Buffer.byteLength(text);
          demand(bytes <= LIMITS.version && files.size < LIMITS.files, "too-large", "版本内容过大，已停止操作。");
          files.set(file, text);
        }
      }
    }
    await visit(); validateFiles(files); return files;
  }
  function unpack(input, files, version) {
    let project, documents, workspace;
    try {
      project = parseSnapshot(input.kind, JSON.parse(files.get("project.json")), input.projectId);
      const metadata = JSON.parse(files.get("documents.json") ?? "[]");
      documents = parseDocuments(metadata.map(item => {
        const content = files.get(`documents/${hash(item.id)}.txt`);
        demand(content !== undefined, "invalid-documents", "此版本缺少剧本文本文件。");
        return { ...item, content };
      }));
      workspace = unpackWorkspace(files, input.projectId);
      const expected = textFiles(project, documents, workspace);
      if (!files.has("documents.json") && !documents.length) expected.delete("documents.json");
      demand(files.size === expected.size && [...files.keys()].every(name => expected.has(name)),
        "invalid-version", "版本含未被元数据引用的文件，已停止操作。");
      boundedJson({ project, documents, ...(workspace === undefined ? {} : { workspace }) });
    } catch (error) {
      if (error instanceof ProjectGitError) throw error;
      throw new ProjectGitError("invalid-version", "版本数据不完整，请选择其他版本。");
    }
    return { project, documents, ...(workspace === undefined ? {} : { workspace }), version, ...mediaInfo(project, workspace) };
  }
  async function capture(root, input) {
    if (input.snapshot === undefined && input.documents === undefined && input.workspace === undefined) return;
    const files = await working(root), previous = files.size ? unpack(input, files, null) : null;
    const project = input.snapshot === undefined ? previous?.project : parseSnapshot(input.kind, input.snapshot, input.projectId);
    demand(project, "invalid-project", "请先捕获工程快照。");
    const documents = input.documents === undefined ? previous?.documents ?? [] : parseDocuments(input.documents);
    const workspace = input.workspace === undefined ? previous?.workspace : parseWorkspace(input.workspace, input.projectId);
    boundedJson({ project, documents, ...(workspace === undefined ? {} : { workspace }) });
    await replaceWork(root, textFiles(project, documents, workspace));
  }
  async function versionId(root, value) {
    demand(typeof value === "string" && /^[a-f0-9]{7,40}$/.test(value), "invalid-version", "请选择有效的版本。");
    const id = (await run(root, ["rev-parse", "--verify", `${value}^{commit}`], { allowMissing: true })).trim();
    demand(/^[a-f0-9]{40}$/.test(id), "unknown-version", "找不到这个版本，请刷新版本列表。");
    const known = (await run(root, ["rev-parse", "--verify", `refs/glint/versions/${id}`], { allowMissing: true })).trim();
    demand(known === id, "unknown-version", "此版本不属于当前工程。"); return id;
  }
  async function versionFiles(root, id) {
    if (!id) return new Map();
    const entries = (await run(root, ["ls-tree", "-r", id, "--"])).trim().split("\n").filter(Boolean);
    demand(entries.length <= LIMITS.files && entries.every(entry => /^100644 blob [a-f0-9]{40}\t/.test(entry)),
      "invalid-version", "版本包含过多文件或特殊文件，已停止操作。");
    const names = entries.map(entry => entry.split("\t")[1]);
    demand(names.every(managedFile), "invalid-version", "版本包含非工程文件，已停止操作。");
    const files = new Map(); let bytes = 0;
    for (const name of names) {
      const text = await run(root, ["show", `${id}:${name}`]); bytes += Buffer.byteLength(text);
      demand(Buffer.byteLength(text) <= fileLimit(name) && bytes <= LIMITS.version, "too-large", "版本内容过大，已停止操作。"); files.set(name, text);
    }
    return files;
  }
  async function hidden(root) {
    const file = path.join(root, "deleted.json");
    const values = await exists(file) ? JSON.parse(await readText(file)) : [];
    demand(Array.isArray(values) && values.every(id => typeof id === "string" && /^[a-f0-9]{40}$/.test(id)), "invalid-version", "已隐藏版本记录损坏，请检查数据目录。");
    return new Set(values);
  }
  async function status(root, input) {
    const current = await head(root), files = await working(root), changedFiles = changed(await versionFiles(root, current), files);
    const versionCount = current ? Number((await run(root, ["rev-list", "--all", "--count"])).trim()) : 0;
    const saved = files.has("project.json") ? unpack(input, files, current) : null;
    const extra = saved ? mediaInfo(saved.project, saved.workspace) : { mediaRefs: [], mediaPolicy: "尚未捕获工程快照。" };
    return { current, versionCount, changedFiles, ...extra };
  }
  async function history(root, input) {
    const current = await head(root), deleted = await hidden(root);
    if (!current) return { versions: [], more: false, deletedCount: 0 };
    const output = await run(root, ["log", "--all", "--date-order", "--max-count=1001", "--format=%H%x00%P%x00%ct%x00%B%x00"]);
    const fields = output.split("\0"), versions = [];
    for (let i = 0; i + 3 < fields.length; i += 4) {
      const id = fields[i].trim(), parents = fields[i + 1].split(" ").filter(Boolean);
      versions.push({ id, parent: parents[0] ?? null, parents, message: fields[i + 3].trimEnd(), at: Number(fields[i + 2]) * 1000,
        deleted: deleted.has(id), current: id === current });
    }
    const filtered = versions.filter(item => input.deleted === true ? item.deleted : input.includeDeleted === true || !item.deleted);
    const limit = Number.isInteger(input.limit) ? Math.min(100, Math.max(1, input.limit)) : 50;
    const offset = Number.isInteger(input.offset) ? Math.min(1000, Math.max(0, input.offset)) : 0;
    return { versions: filtered.slice(offset, offset + limit), more: filtered.length > offset + limit || versions.length > 1000, deletedCount: deleted.size };
  }
  async function dispatch(root, input) {
    const { operation } = input;
    if (operation === "commit") demand(input.message === undefined || typeof input.message === "string" && input.message.length <= 2000 && !/[\0\x1e\x1f]/.test(input.message),
      "invalid-message", "版本说明不能超过 2000 字或包含控制字符。");
    if (["open", "commit"].includes(operation)) await capture(root, input);
    if (operation === "open" || operation === "status") return status(root, input);
    if (operation === "history") return history(root, input);
    if (operation === "diff") {
      const current = await head(root), id = input.version === undefined ? null : await versionId(root, input.version);
      const parent = id ? (await run(root, ["rev-list", "--parents", "-n", "1", id])).trim().split(" ")[1] : current;
      const before = await versionFiles(root, parent), after = id ? await versionFiles(root, id) : await working(root);
      if (before.size) unpack(input, before, parent);
      if (after.size) unpack(input, after, id);
      const files = changed(before, after).map(item => ({ ...item, before: before.get(item.path) ?? "", after: after.get(item.path) ?? "" }));
      return { files, version: id, current };
    }
    if (operation === "commit") {
      const state = await status(root, input);
      demand(state.changedFiles.length > 0, "nothing", "没有需要保存的更改。");
      unpack(input, await working(root), null);
      await run(root, ["add", "-A", "--", "."]);
      await run(root, ["commit", "--no-gpg-sign", "--cleanup=verbatim", "--file=-"], { input: input.message?.trim() || "保存版本" });
      const version = await head(root);
      await run(root, ["update-ref", `refs/glint/versions/${version}`, version]);
      return { version, ...await status(root, input) };
    }
    if (operation === "deleteVersions" || operation === "recoverVersions") {
      const selected = input.versions ?? (input.version ? [input.version] : []);
      demand(Array.isArray(selected) && selected.length > 0 && selected.length <= 100, "invalid-version", "请一次选择 1 到 100 个版本。");
      const ids = [];
      for (const item of selected) ids.push(await versionId(root, item));
      const deleted = await hidden(root), current = await head(root);
      demand(operation !== "deleteVersions" || !ids.includes(current), "current-version", "当前版本不能隐藏，请先切换到其他版本。");
      for (const id of ids) if (operation === "deleteVersions") deleted.add(id); else deleted.delete(id);
      await atomicJson(path.join(root, "deleted.json"), [...deleted]);
      return { versions: ids, ...await status(root, input) };
    }
    const current = await head(root), version = operation === "discard" ? current : await versionId(root, input.version);
    demand(version, "none", "还没有已保存版本，请先保存一个版本。");
    const files = await versionFiles(root, version), result = unpack(input, files, version);
    if (operation === "copy") {
      const projectId = randomUUID();
      const rewrite = value => Array.isArray(value) ? value.map(rewrite) : value && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === "projectId" ? projectId : rewrite(item)])) : value;
      const project = parseSnapshot(input.kind, { ...rewrite(result.project), id: projectId }, projectId);
      const workspace = result.workspace === undefined ? undefined : copyProjectWorkspace(result.workspace, projectId);
      return { ...result, projectId, project, ...(workspace === undefined ? {} : { workspace }) };
    }
    if (operation === "checkout") {
      demand(!(await status(root, input)).changedFiles.length, "dirty", "有未保存的更改，请先保存版本或放弃更改后再恢复。");
      demand(!(await hidden(root)).has(version), "deleted-version", "此版本已隐藏，请先恢复版本记录。");
    }
    await replaceWork(root, files);
    if (operation === "checkout") await run(root, ["update-ref", "--no-deref", "HEAD", version]);
    await run(root, ["read-tree", version]);
    return result;
  }
  return {
    async request(value) {
      try {
        demand(!disposed, "disposed", "版本服务已关闭，请重新打开工程。");
        const input = boundedJson(value);
        demand(input?.action === "git" && OPERATIONS.has(input.operation), "invalid-request", "不支持这个版本操作。");
        demand(typeof input.projectId === "string" && input.projectId.length > 0 && input.projectId.length <= 256 && !/[\0\r\n]/.test(input.projectId)
          && ["scene", "nle"].includes(input.kind), "invalid-project", "请选择有效的工程和工程类型。");
        demand(pending < LIMITS.pending, "busy", "版本操作较多，请稍后重试。");
        pending++;
        const key = repositoryKey(input.projectId, input.kind), previous = locks.get(key) ?? Promise.resolve();
        const task = previous.catch(() => {}).then(async () => {
          demand(!disposed, "disposed", "版本服务已关闭，操作已取消。");
          return dispatch(await ready(input), input);
        });
        locks.set(key, task);
        try { return boundedJson({ ok: true, ...await task }, LIMITS.output); }
        finally { pending--; if (locks.get(key) === task) locks.delete(key); }
      } catch (error) {
        return { ok: false, error: { code: error instanceof ProjectGitError ? error.code : "git-storage",
          message: error instanceof ProjectGitError ? error.message : "无法读写本地版本数据，请检查磁盘空间和数据目录权限后重试。" } };
      }
    },
    async dispose() { disposed = true; await git.dispose(); await Promise.allSettled(locks.values()); },
  };
}
