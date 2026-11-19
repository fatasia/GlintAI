import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { resolveRuntime, invocation } from "../../../skills/glint-video/scripts/glint.mjs";

const repo = fileURLToPath(new URL("../../../", import.meta.url)), roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) {
  if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("Unexpected test cleanup path");
  fs.rmSync(root, { recursive: true, force: true });
} });
it("keeps the shebang launcher LF after a real autocrlf checkout and runs it outside the repository", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-skill-checkout-")); roots.push(root);
  const relative = "skills/glint-video/scripts/glint.mjs", launcher = path.join(root, relative);
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  fs.copyFileSync(path.join(repo, relative), launcher);
  const attributes = path.join(repo, ".gitattributes");
  if (fs.existsSync(attributes)) fs.copyFileSync(attributes, path.join(root, ".gitattributes"));
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "-c", `core.hooksPath=${path.join(root, "no-hooks")}`, ...args], { cwd: root, windowsHide: true, stdio: "pipe" });
  git("init"); git("config", "core.autocrlf", "true"); git("config", "core.safecrlf", "false");
  git("add", "."); git("commit", "-m", "fixture"); fs.unlinkSync(launcher); git("checkout", "HEAD", "--", relative);
  const bytes = fs.readFileSync(launcher, "utf8");
  expect(bytes.startsWith("#!/usr/bin/env node\n")).toBe(true);
  expect(bytes).not.toContain("\r");
  const imported = await import(/* @vite-ignore */ pathToFileURL(launcher).href);
  expect(imported.resolveRuntime({ root: repo, cwd: root, env: {} })).toBe(path.resolve(repo));
  const output = execFileSync(process.execPath, [launcher, `--root=${repo}`, "help"], { cwd: root, env: { ...process.env, NODE_OPTIONS: "" }, timeout: 20_000, windowsHide: true, encoding: "utf8" });
  expect(output).toContain("pnpm glint make");
});
it("resolves an explicit runtime and refuses an invalid explicit root instead of silently falling back", () => {
  expect(resolveRuntime({ root: repo, cwd: os.tmpdir(), env: {} })).toBe(path.resolve(repo));
  expect(() => resolveRuntime({ root: path.join(repo, "missing"), cwd: repo, env: {} })).toThrow(/runtime|运行时/);
  expect(resolveRuntime({ cwd: os.tmpdir(), env: { GLINT_ROOT: repo } })).toBe(path.resolve(repo));
});
it("passes arguments without shell interpolation and preserves the external agent working directory", () => {
  const run = invocation([`--root=${repo}`, "srt", "--project=a file.json", "--out=result.srt"], { cwd: os.tmpdir(), env: { INIT_CWD: "stale" } });
  expect(run.args.slice(-3)).toEqual(["srt", "--project=a file.json", "--out=result.srt"]);
  expect(run.env.INIT_CWD).toBe(os.tmpdir()); expect(run.cwd).toBe(path.join(repo, "apps", "studio"));
  expect(run.args).not.toContain(`--root=${repo}`);
});
it("a copied skill runs outside the repository and writes subtitles beside the caller input", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-skill-entry-")); roots.push(root);
  const installed = path.join(root, "installed", "glint-video"), work = path.join(root, "agent-work"); fs.mkdirSync(work, { recursive: true });
  fs.cpSync(path.join(repo, "skills", "glint-video"), installed, { recursive: true });
  const project = { schemaVersion: 1, id: "external-agent", title: "独立 Skill", aspect: "16:9", knowledgeSources: [], scenes: [{ id: "one", kind: "title", title: "开始", narration: { text: "这段字幕来自外部 Agent 的工程。", durationMs: 2000 } }] };
  const source = JSON.stringify(project); fs.writeFileSync(path.join(work, "input project.json"), source);
  execFileSync(process.execPath, [path.join(installed, "scripts", "glint.mjs"), `--root=${repo}`, "srt", "--project=input project.json", "--out=output.srt"], { cwd: work, env: { ...process.env, NODE_OPTIONS: "" }, timeout: 20_000, windowsHide: true });
  expect(fs.readFileSync(path.join(work, "output.srt"), "utf8")).toContain("这段字幕来自外部 Agent 的工程。");
  expect(fs.readFileSync(path.join(work, "input project.json"), "utf8")).toBe(source);
});
