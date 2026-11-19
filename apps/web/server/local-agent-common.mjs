import { createHash, randomUUID } from "node:crypto";
import { open, lstat, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export const LIMITS = Object.freeze({ projectBytes: 2 * 1024 * 1024, eventBytes: 3 * 1024 * 1024,
  logBytes: 3 * 1024 * 1024, events: 256, stderrBytes: 16 * 1024, text: 32000,
  contextBytes: 64000, conversations: 64, pending: 16, requestMs: 30000, turnMs: 10 * 60000, permissionMs: 60000 });
export class LocalAgentError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export function demand(condition, code, message) { if (!condition) throw new LocalAgentError(code, message); }
export function boundedJson(value, maxBytes) {
  let text;
  try { text = JSON.stringify(value); } catch { throw new LocalAgentError("invalid-input", "输入必须是 JSON 数据。"); }
  demand(typeof text === "string" && Buffer.byteLength(text) <= maxBytes, "too-large", "数据超过本地会话大小限制。");
  return JSON.parse(text);
}
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export const digest = value => createHash("sha256").update(canonical(value)).digest("hex");
export function redact(value) {
  if (typeof value === "string") return value.replace(/((?:api[_-]?key|access[_-]?token|authorization|password|secret)\s*[=:]\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+[^\s,;]+)/g, "[redacted]");
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !/^(?:_meta|env|auth|credentials|api[_-]?key|access[_-]?token|token|secret|password)$/i.test(key)).map(([key, entry]) => [key, redact(entry)]));
  return value;
}
export async function ensureDirectory(directory) {
  await mkdir(directory, { recursive: true });
  const stat = await lstat(directory);
  demand(stat.isDirectory() && !stat.isSymbolicLink(), "unsafe-path", "本地会话目录不能是链接。");
}
export async function readBounded(file, limit) {
  const stat = await lstat(file);
  demand(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= limit, "unsafe-file", "会话文件无效、为链接或超过大小限制。");
  const handle = await open(file, "r");
  try {
    const current = await handle.stat();
    demand(current.ino === stat.ino && current.size <= limit, "unsafe-file", "会话文件已变化。");
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size <= limit) { const part = await handle.read(buffer, size, limit + 1 - size, size); if (!part.bytesRead) break; size += part.bytesRead; }
    demand(size <= limit, "too-large", "会话文件超过大小限制。");
    return JSON.parse(buffer.subarray(0, size).toString("utf8"));
  } finally { await handle.close(); }
}
export async function atomicJson(file, value) {
  const temp = path.join(path.dirname(file), `.local-agent-${randomUUID()}.tmp`);
  try { await writeFile(temp, JSON.stringify(value), { flag: "wx", mode: 0o600 }); await rename(temp, file); }
  finally { await unlink(temp).catch(error => { if (error.code !== "ENOENT") throw error; }); }
}
export function errorResult(error) {
  const code = error?.code === -32000 || /auth|login|unauthenticated/i.test(error?.message ?? "") ? "login-required" : error instanceof LocalAgentError ? error.code : "agent-error";
  return { ok: false, error: { code, message: error instanceof LocalAgentError ? error.message : code === "login-required" ? "请先在该代理的官方 CLI 中完成登录，再重新连接。" : "本地代理操作失败，请检查代理安装和本地登录状态后重试。" } };
}
