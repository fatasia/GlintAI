import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { killMediaProcess } from "../../studio/scripts/native-process";
import { validatePortableChapterBundle, type ValidatedPortableBundle } from "../../../packages/scenescript/src/portable-chapter-validation";
import { parseProject } from "../../../packages/scenescript/src/parse";
import { referencedAssets } from "../../../packages/scenescript/src/chapter-bundle";

const LIMIT = 32 * 1024 * 1024;
const MEDIA_NAME = /^[a-zA-Z0-9_-]{1,100}\.(png|jpg|webp|mp4|mp3|wav)$/;
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const checkAbort = (signal?: AbortSignal) => { if (signal?.aborted) throw signal.reason ?? new Error("章节迁移已取消。"); };
const DEADLINE_MS = 30_000;
const OUTPUT_LIMIT = 128 * 1024;
type Budget = { deadline: number; signal?: AbortSignal };
const checkBudget = (budget: Budget) => {
  checkAbort(budget.signal);
  if (performance.now() >= budget.deadline) throw new Error("章节迁移超过整包处理时限。");
};

function runDecoder(command: string, args: string[], bytes: Buffer, budget: Budget): Promise<Buffer> {
  checkBudget(budget);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false });
    let failure: unknown;
    let size = 0;
    const output: Buffer[] = [];
    const stop = (error: unknown) => { if (!failure) failure = error; killMediaProcess(child, "SIGKILL"); };
    const abort = () => stop(budget.signal?.reason ?? new Error("章节迁移已取消。"));
    const timer = setTimeout(() => stop(new Error("章节迁移超过整包处理时限。")), Math.max(0, budget.deadline - performance.now()));
    budget.signal?.addEventListener("abort", abort, { once: true });
    if (budget.signal?.aborted) abort();
    const collect = (chunk: Buffer, keep: boolean) => {
      size += chunk.length;
      if (size > OUTPUT_LIMIT) stop(new Error("素材解码器输出超过上限。"));
      else if (keep) output.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(chunk, true));
    child.stderr.on("data", (chunk: Buffer) => collect(chunk, false));
    child.stdin.on("error", () => { /* A failed decoder may close stdin before consuming it. */ });
    child.on("error", error => { failure ??= new Error("素材解码器不可用，请检查 FFmpeg 安装。", { cause: error }); });
    child.on("close", code => {
      clearTimeout(timer);
      budget.signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error("素材探测失败或无法完整解码。"));
      else {
        try { checkBudget(budget); resolve(Buffer.concat(output)); } catch (error) { reject(error); }
      }
    });
    child.stdin.end(bytes);
  });
};

type Snapshot = ValidatedPortableBundle["chapters"][number]["snapshot"];
type ReadAsset = (name: string) => Buffer | Promise<Buffer>;
export type SecureAssetStore = { read(name: string): Promise<Buffer>; publish(name: string, bytes: Buffer): Promise<unknown> };

// The decoder reads only stdin; no network or file protocols are allowed. A successful
// signature or metadata probe alone is not evidence that the complete media decodes.
async function decode(bytes: Buffer, extension: string, budget: Budget) {
  const probe = await runDecoder("ffprobe", ["-v", "error", "-max_alloc", "67108864", "-protocol_whitelist", "pipe", "-show_entries", "stream=codec_type,codec_name,width,height:format=duration", "-of", "json", "-i", "pipe:0"], bytes, budget);
  let info: { streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number }>; format?: { duration?: string } };
  try { info = JSON.parse(probe.toString()); } catch { throw new Error("素材探测结果无效。"); }
  const image = ["png", "jpg", "webp"].includes(extension);
  const stream = info.streams?.find(item => item.codec_type === (image || extension === "mp4" ? "video" : "audio"));
  const expected: Record<string, string> = { png: "png", jpg: "mjpeg", webp: "webp", mp3: "mp3", wav: "pcm_" };
  if (!stream || (expected[extension] && !(extension === "wav" ? stream.codec_name?.startsWith(expected.wav!) : stream.codec_name === expected[extension]))) throw new Error("素材类型与解码格式不一致。");
  if (image && (!Number.isInteger(stream.width) || !Number.isInteger(stream.height) || stream.width! < 1 || stream.height! < 1 || stream.width! > 8192 || stream.height! > 8192 || stream.width! * stream.height! > 16_777_216)) throw new Error("图片尺寸无效或过大。");
  await runDecoder("ffmpeg", ["-v", "error", "-max_alloc", "67108864", "-xerror", "-abort_on", "empty_output", "-err_detect", "explode", "-protocol_whitelist", "pipe", "-threads", "1", "-i", "pipe:0", "-map", "0:v?", "-map", "0:a?", "-threads", "1", "-f", "null", "-"], bytes, budget);
}

/** Shared byte-only gate for native project archives. No file or network protocols. */
export async function validatePortableMedia(bytes: Buffer, extension: string, signal?: AbortSignal) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > LIMIT || !["png", "jpg", "webp", "mp4", "mp3", "wav"].includes(extension)) throw new Error("素材格式或大小无效。");
  await decode(bytes, extension, { deadline: performance.now() + DEADLINE_MS, signal });
}

async function validate(serialized: string, budget: Budget) {
  checkBudget(budget);
  const validated = validatePortableChapterBundle(serialized);
  const raw = JSON.parse(serialized) as { chapters: Array<{ snapshot: unknown }> };
  if (!isDeepStrictEqual(raw.chapters.map(chapter => chapter.snapshot), validated.chapters.map(chapter => chapter.snapshot))) throw new Error("章节快照包含无法完整恢复的数据，请先检查工程格式。");
  for (const blob of validated.blobs.values()) await decode(blob.bytes, blob.extension, budget);
  checkBudget(budget);
  return validated;
}

/** Export a complete v2 snapshot only after validating every reference and decoded byte. */
export async function exportPortableChapters(snapshots: Snapshot[], readAsset: ReadAsset, signal?: AbortSignal): Promise<string> {
  const budget: Budget = { deadline: performance.now() + DEADLINE_MS, signal };
  checkBudget(budget);
  if (!Array.isArray(snapshots) || !snapshots.length || snapshots.length > 100) throw new Error("章节数量无效。");
  let total = 0, count = 0;
  const chapters = [];
  for (const snapshot of snapshots) {
    const refs = referencedAssets(snapshot.project);
    const assets = [];
    for (const ref of refs) {
      checkBudget(budget);
      const name = ref.slice(7);
      if (!MEDIA_NAME.test(name)) throw new Error(`素材名称无效：${ref}`);
      const bytes = await readAsset(name);
      checkBudget(budget);
      if (!Buffer.isBuffer(bytes) || !bytes.length) throw new Error(`素材缺失：${ref}`);
      total += bytes.length; if (++count > 5000 || total > LIMIT * 3 / 4) throw new Error("章节素材超过迁移包上限。");
      assets.push({ path: ref, sha256: hash(bytes), bytes: bytes.length, data: bytes.toString("base64") });
    }
    chapters.push({ snapshot, assets });
  }
  const serialized = JSON.stringify({ format: "glint-chapters-portable", version: 2, chapters });
  const validated = await validate(serialized, budget);
  // Schema parsing strips unknown fields: silently exporting those would lose user data.
  if (!isDeepStrictEqual(snapshots, validated.chapters.map(chapter => chapter.snapshot))) throw new Error("章节快照包含无法完整恢复的数据，请先检查工程格式。");
  return serialized;
}

async function regularBytes(file: string): Promise<Buffer> {
  const stat = await fs.promises.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > LIMIT) throw new Error("目标素材不是受控普通文件。");
  const fd = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = await fd.stat();
    if (!opened.isFile() || opened.size !== stat.size || opened.ino !== stat.ino || opened.dev !== stat.dev) throw new Error("目标素材在检查期间发生变化。");
    return await fd.readFile();
  } finally { await fd.close(); }
}

async function verifyExisting(file: string, expected: Buffer, digest: string) {
  const bytes = await regularBytes(file);
  if (bytes.length !== expected.length || hash(bytes) !== digest || !bytes.equals(expected)) throw new Error("素材名称冲突：已有文件内容不一致，未覆盖。");
}

// SECURITY: These path-based helpers are for isolated tests only. Neither lstat nor
// realpath pins ancestor directories on Windows; a same-user junction replacement can
// redirect every subsequent operation, including cleanup. Do not expose them to requests
// until a handle-relative, no-reparse implementation and authenticated sessions exist.
async function preparePortableChapters(serialized: string, library: string | SecureAssetStore, budget: Budget) {
  const validated = await validate(serialized, budget);
  let root = "";
  if (typeof library === "string") {
    const rootStat = await fs.promises.lstat(library);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("素材库目录无效。");
    root = await fs.promises.realpath(library);
  }
  const names = new Map<string, string>();
  const approved = new Set<string>();
  for (const { snapshot, assets } of validated.chapters) for (const identity of snapshot.project.assets ?? []) {
    if (!identity.approval?.refSha256) continue;
    const ref = identity.approval.refs[0];
    const entry = assets.find(asset => asset.path === ref);
    if (!entry || entry.sha256 !== identity.approval.refSha256) throw new Error("已批准素材的内容与冻结摘要不一致。");
    approved.add(entry.sha256);
  }
  for (const [digest, blob] of validated.blobs) names.set(digest, `${approved.has(digest) ? "approved" : "chapter"}-${digest}.${blob.extension}`);
  // Validate rewritten projects before publishing anything: frozen approvals and other
  // schema constraints may depend on their original content-addressed path.
  const chapters = validated.chapters.map(({ snapshot, assets }) => {
    const replacements = new Map(assets.map(entry => [entry.path, `assets/${names.get(entry.sha256)!}`]));
    const project = structuredClone(snapshot.project);
    const replace = (ref: string) => replacements.get(ref) ?? ref;
    if (project.music) project.music.src = replace(project.music.src);
    for (const identity of project.assets ?? []) {
      if (identity.refs) identity.refs = identity.refs.map(replace);
      if (identity.approval) identity.approval.refs = identity.approval.refs.map(replace);
    }
    for (const scene of project.scenes) {
      if (scene.narration.audioRef) scene.narration.audioRef = replace(scene.narration.audioRef);
      if (scene.kind === "image" || scene.kind === "video" || (scene.kind === "three" && scene.model === "gltf")) scene.src = replace(scene.src);
    }
    // The exporter discovers references recursively. Reject any field we cannot
    // rewrite rather than silently returning a project pointing at absent files.
    const assertRewritten = (original: unknown, rewritten: unknown, location: string[] = []): void => {
      const userText = location.length === 1 && location[0] === "title" ||
        location.length === 3 && location[0] === "scenes" && location[2] === "notes" ||
        location.length === 4 && location[0] === "scenes" && location[2] === "narration" && location[3] === "text";
      if (userText) return;
      if (typeof original === "string" && original.startsWith("assets/") && replacements.has(original) && rewritten !== replace(original)) throw new Error(`工程包含无法迁移的素材引用：${original}`);
      if (Array.isArray(original) && Array.isArray(rewritten)) original.forEach((item, index) => assertRewritten(item, rewritten[index], [...location, String(index)]));
      else if (original && rewritten && typeof original === "object" && typeof rewritten === "object") for (const [key, value] of Object.entries(original)) assertRewritten(value, (rewritten as Record<string, unknown>)[key], [...location, key]);
    };
    assertRewritten(snapshot.project, project);
    if (!isDeepStrictEqual(project, parseProject(project))) throw new Error("迁移后的工程无法完整恢复。");
    return { ...snapshot, project };
  });
  // Detect every pre-existing conflict before making any changes.
  for (const [digest, blob] of validated.blobs) {
    checkBudget(budget);
    const name = names.get(digest)!;
    try {
      if (typeof library === "string") await verifyExisting(path.join(root, name), blob.bytes, digest);
      else {
        const bytes = await library.read(name);
        if (!bytes.equals(blob.bytes)) throw new Error("素材名称冲突：已有文件内容不一致，未覆盖。");
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  checkBudget(budget);
  return { validated, root, names, chapters };
}

/** Full validation and conflict detection without publishing any files. */
export async function preflightPortableChapters(serialized: string, libraryRoot: string | SecureAssetStore, signal?: AbortSignal) {
  const budget: Budget = { deadline: performance.now() + DEADLINE_MS, signal };
  const { chapters } = await preparePortableChapters(serialized, libraryRoot, budget);
  return { importId: hash(serialized), chapters };
}

/** Revalidate before writes. Published blobs are immutable and never rolled back:
 * an interrupted retry verifies and reuses them instead of deleting data. */
export async function importPortableChapters(serialized: string, libraryRoot: string | SecureAssetStore, signal?: AbortSignal, authorize: () => void = () => {}) {
  const budget: Budget = { deadline: performance.now() + DEADLINE_MS, signal };
  const { validated, root, names, chapters } = await preparePortableChapters(serialized, libraryRoot, budget);
  authorize();
  for (const [digest, blob] of validated.blobs) {
    checkBudget(budget);
    authorize();
    if (typeof libraryRoot !== "string") {
      await libraryRoot.publish(names.get(digest)!, blob.bytes);
      checkBudget(budget);
      continue;
    }
    if (await fs.promises.realpath(libraryRoot) !== root) throw new Error("素材库目录发生变化。");
    const file = path.join(root, names.get(digest)!);
    try { await verifyExisting(file, blob.bytes, digest); continue; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    checkBudget(budget);
    authorize();
    const temp = path.join(root, `.chapter-incoming-${randomUUID()}`);
    const fd = await fs.promises.open(temp, "wx", 0o600);
    try {
      try { await fd.writeFile(blob.bytes); await fd.sync(); } finally { await fd.close(); }
      checkBudget(budget);
      authorize();
      try { await fs.promises.link(temp, file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      await verifyExisting(file, blob.bytes, digest);
    } finally { await fs.promises.unlink(temp); }
  }
  checkBudget(budget);
  return { importId: hash(serialized), chapters };
}
