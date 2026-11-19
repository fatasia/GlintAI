import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, mkdir, rm, link } from "node:fs/promises";
import { EventEmitter } from "node:events";
import path from "node:path";
import os from "node:os";
// @ts-expect-error server module
import { createCatalog, resolveCommand, CATALOG } from "./local-agent-catalog.mjs";
// @ts-expect-error server module
import { stopOwnedProcess, safeEnvironment } from "./local-agent-process.mjs";
// @ts-expect-error server module
import { validateProposal } from "./local-agent-proposals.mjs";
// @ts-expect-error server module
import { readBounded, digest, redact } from "./local-agent-common.mjs";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function directory() { const result = await mkdtemp(path.join(os.tmpdir(), "agent-boundary-")); directories.push(result); return result; }
it("finds only fixed PATH candidates, resolves npm shims without shell, ignores config directories", async () => {
  const dir = await directory(), home = await directory(); await mkdir(path.join(home, ".kimi"));
  const detect = createCatalog({ platform: "win32", env: { PATH: dir, USERPROFILE: home } });
  await expect(detect("kimi")).rejects.toMatchObject({ code: "not-installed" });
  // Bundled adapters are dependencies, not evidence of an installed user CLI.
  await expect(detect("claude")).rejects.toMatchObject({ code: "not-installed" });
  await expect(detect("codex")).rejects.toMatchObject({ code: "not-installed" });
  const target = path.join(dir, "entry.js"); await writeFile(target, "// offline fixture, never executed");
  const shim = path.join(dir, "qwen.cmd"); await writeFile(shim, '@node "%~dp0\\entry.js" %*');
  const result = await detect("qwen"); expect(result.command).toBe(process.execPath); expect(result.args).toEqual([target, "--acp"]);
  await writeFile(path.join(dir, "codex.cmd"), '@node "%~dp0\\entry.js" %*');
  expect(await detect("codex")).toMatchObject({ command: process.execPath, cliEnv: { CODEX_PATH: target } });
  await expect(resolveCommand(home)).rejects.toMatchObject({ code: "invalid-path" });
  await writeFile(path.join(dir, "custom.cmd"), "arbitrary shell command");
  await expect(resolveCommand(path.join(dir, "custom.cmd"))).rejects.toMatchObject({ code: "invalid-shim" });
  expect(CATALOG).toHaveLength(6); expect(JSON.stringify(CATALOG)).not.toMatch(/bypass|allow-all|yolo/);
});
it("rejects Windows GUI PE executables and accepts console PE without executing either", async () => {
  const dir = await directory();
  const exe = (subsystem: number) => { const bytes = Buffer.alloc(256); bytes.write("MZ"); bytes.writeUInt32LE(64, 60); bytes.write("PE\0\0", 64); bytes.writeUInt16LE(subsystem, 64 + 92); return bytes; };
  const gui = path.join(dir, "qwen.exe"), cli = path.join(dir, "kimi.exe");
  await writeFile(gui, exe(2)); await writeFile(cli, exe(3));
  await expect(resolveCommand(gui)).rejects.toMatchObject({ code: "invalid-path" });
  expect(await resolveCommand(cli)).toMatchObject({ command: cli });
});
it("cleans only its owned Windows PID tree without shell and reports failed cleanup", async () => {
  const child = { pid: 73123, kill: vi.fn() };
  const spawnKiller = vi.fn(() => { const killer = new EventEmitter(); queueMicrotask(() => killer.emit("close", 0)); return killer; });
  expect(await stopOwnedProcess(child, { platform: "win32", spawnKiller })).toBe(true);
  expect(spawnKiller).toHaveBeenCalledWith("taskkill.exe", ["/PID", "73123", "/T", "/F"], expect.objectContaining({ shell: false }));
  const failed = () => { const killer = new EventEmitter(); queueMicrotask(() => killer.emit("error", new Error("mock failure"))); return killer; };
  expect(await stopOwnedProcess(child, { platform: "win32", spawnKiller: failed })).toBe(false); expect(child.kill).toHaveBeenCalledOnce();
  expect(safeEnvironment({ PATH: "cli", OPENAI_API_KEY: "synthetic", NODE_OPTIONS: "--require malicious", GH_TOKEN: "synthetic" })).toEqual({ PATH: "cli", NO_BROWSER: "1", BROWSER: "none" });
  expect(safeEnvironment({ HTTPS_PROXY: "http://localhost:8080", CODEX_HOME: "D:/mock-config" })).toMatchObject({ HTTPS_PROXY: "http://localhost:8080", CODEX_HOME: "D:/mock-config" });
});
it("bounds files, refuses hard links, redacts synthetic credentials and keeps digest key-order stable", async () => {
  const dir = await directory(), file = path.join(dir, "proposal.json"); await writeFile(file, '{"a":1}');
  await expect(readBounded(file, 2)).rejects.toMatchObject({ code: "unsafe-file" });
  await link(file, path.join(dir, "linked.json")); await expect(readBounded(file, 100)).rejects.toMatchObject({ code: "unsafe-file" });
  expect(digest({ a: 1, b: [2, 3] })).toBe(digest({ b: [2, 3], a: 1 }));
  expect(redact({ token: "synthetic", api_key: "synthetic", text: "api_key=synthetic" })).toEqual({ text: "api_key=[redacted]" });
});
it("preserves scene locks, frozen project and approved identity against modification or relocation", () => {
  const base = { schemaVersion: 1, id: "demo", title: "Title", aspect: "16:9", knowledgeSources: [], scenes: [{ id: "one", kind: "title", title: "Locked", narration: { text: "Hi" }, locked: true }] };
  expect(() => validateProposal("scene", base, { ...base, scenes: [{ ...base.scenes[0], title: "Changed" }] })).toThrow(/锁定/);
  expect(() => validateProposal("scene", { ...base, frozen: true }, { ...base, title: "Changed", frozen: true })).toThrow(/冻结/);
  expect(() => validateProposal("scene", base, { ...base, id: "other" })).toThrow(/ID/);
});
