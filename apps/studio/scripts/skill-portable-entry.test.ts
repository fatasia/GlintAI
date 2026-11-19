import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { resolveRuntime, invocation } from "../../../skills/glint-video/scripts/glint.mjs";

const repo = fileURLToPath(new URL("../../../", import.meta.url)), roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) {
  if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("Unexpected test cleanup path");
  fs.rmSync(root, { recursive: true, force: true });
} });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint portable skill ")); roots.push(root);
  const app = path.join(root, "app"), entry = path.join(app, "cli", "glint.mjs");
  fs.mkdirSync(path.dirname(entry), { recursive: true }); fs.mkdirSync(path.join(app, "studio"));
  fs.writeFileSync(path.join(app, "build.json"), JSON.stringify({ version: "0.1.0", commit: "abcdef0", dirty: false, mode: "lite" }));
  fs.writeFileSync(entry, 'process.stdout.write(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),caller:process.env.INIT_CWD,entry:process.env.GLINT_CLI_ENTRY}));process.exitCode=process.argv.includes("fail")?7:0;');
  return { root, app, entry };
}
it("recognizes only the fixed portable layout and preserves source resolution", () => {
  const { root, app, entry } = fixture();
  expect(resolveRuntime({ root, cwd: os.tmpdir(), env: {} })).toBe(root);
  expect(resolveRuntime({ cwd: os.tmpdir(), env: { GLINT_ROOT: root } })).toBe(root);
  expect(resolveRuntime({ cwd: path.join(app, "studio"), env: {} })).toBe(root);
  expect(resolveRuntime({ cwd: os.tmpdir(), env: {}, entryUrl: pathToFileURL(path.join(root, "skills/glint-video/scripts/glint.mjs")).href })).toBe(root);
  expect(invocation([`--root=${repo}`, "help"], { env: {} }).runtime).toBe("source");
  fs.unlinkSync(entry);
  expect(() => resolveRuntime({ root, cwd: repo, env: {} })).toThrow(/runtime|运行时/);
});
it.each(["{}", "invalid JSON", JSON.stringify({ version: "0.1.0", commit: "abcdef0", dirty: false, mode: "arbitrary" }), " ".repeat(4097)])("rejects malformed build identity without fallback", identity => {
  const { root, app } = fixture(); fs.writeFileSync(path.join(app, "build.json"), identity);
  expect(() => resolveRuntime({ root, cwd: repo, env: {} })).toThrow(/runtime|运行时/);
});
it("pins entry and resource paths while preserving caller arguments and credentials", () => {
  const { root, app, entry } = fixture(), cwd = os.tmpdir();
  const run = invocation(["--root", root, "srt", "--project=a file; &.json", "--out=result.srt"], { cwd, env: {
    INIT_CWD: "stale", GLINT_STUDIO_DIR: "wrong", GLINT_CLI_ENTRY: "wrong", GLINT_MAKE_ENTRY: "wrong", GLINT_MAKE_NODE: "wrong",
    GLINT_RUNTIME_ASSETS: "wrong", GLINT_PREBUILT_BUNDLE: "wrong", GLINT_NLE_HARNESS: "wrong", GLINT_DIRECT_BROWSER_HARNESS: "wrong", GLINT_ACCESS_TOKEN: "fixture-token"
  } });
  expect(run.runtime).toBe("portable"); expect(run.command).toBe(process.execPath);
  expect(run.args).toEqual([entry, "srt", "--project=a file; &.json", "--out=result.srt"]);
  expect(run.cwd).toBe(path.join(app, "studio")); expect(run.env.INIT_CWD).toBe(cwd);
  expect(run.env.GLINT_ACCESS_TOKEN).toBe("fixture-token");
  expect(run.env.GLINT_CLI_ENTRY).toBe(entry); expect(run.env.GLINT_MAKE_ENTRY).toBe(entry);
  expect(run.env.GLINT_MAKE_NODE).toBe(process.execPath); expect(run.env.GLINT_BUILD_FILE).toBe(path.join(app, "build.json"));
  expect(run.env.GLINT_RUNTIME_ASSETS).toBe(path.join(app, "runtime-assets"));
  expect(run.env.GLINT_PREBUILT_BUNDLE).toBe(path.join(app, "remotion-bundle"));
  expect(run.env.GLINT_NLE_HARNESS).toBe(path.join(app, "cli", "nle-harness.js"));
  expect(run.env.GLINT_DIRECT_BROWSER_HARNESS).toBe(path.join(app, "cli", "direct-browser.js"));
});
it("a copied launcher reports portable readiness, executes without tsx and propagates failure", () => {
  const { root, entry } = fixture(), installed = path.join(root, "external agent skill"), work = path.join(root, "agent work");
  fs.mkdirSync(work); fs.mkdirSync(installed);
  const launcher = path.join(installed, "glint.mjs"); fs.copyFileSync(path.join(repo, "skills/glint-video/scripts/glint.mjs"), launcher);
  const options = { cwd: work, env: { ...process.env, NODE_OPTIONS: "", GLINT_ROOT: root }, timeout: 20_000, windowsHide: true, encoding: "utf8" as const };
  const ready = JSON.parse(execFileSync(process.execPath, [launcher, "--runtime-check"], options));
  expect(ready).toEqual({ ready: true, runtime: "portable", desktopRequired: false });
  const result = JSON.parse(execFileSync(process.execPath, [launcher, "srt", "--project=a file; &.json"], options));
  expect(result).toEqual({ args: ["srt", "--project=a file; &.json"], cwd: path.join(root, "app/studio"), caller: work, entry });
  expect(spawnSync(process.execPath, [launcher, "fail"], options).status).toBe(7);
  expect(spawnSync(process.execPath, [launcher, "--root=missing", "--runtime-check"], options).status).toBe(1);
});
