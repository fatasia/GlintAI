#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

function isRuntime(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).name === "glint" && fs.statSync(path.join(root, "apps/studio/scripts/glint.ts")).isFile(); }
  catch { return false; }
}
function portableApp(root) {
  const app = path.join(root, "app");
  try {
    const identity = path.join(app, "build.json");
    if (!fs.statSync(identity).isFile() || fs.statSync(identity).size > 4096) return;
    const build = JSON.parse(fs.readFileSync(identity, "utf8"));
    if (!build || typeof build.version !== "string" || !build.version.trim() || build.version.length > 64 ||
      typeof build.commit !== "string" || !/^(?:[a-f0-9]{7,40}|unknown)$/.test(build.commit) ||
      typeof build.dirty !== "boolean" || !["lite", "full"].includes(build.mode)) return;
    if (fs.statSync(path.join(app, "cli", "glint.mjs")).isFile() && fs.statSync(path.join(app, "studio")).isDirectory()) return app;
  } catch { return; }
}
function hasRuntime(root) { return isRuntime(root) || Boolean(portableApp(root)); }
function ancestors(directory) {
  const result = []; let current = path.resolve(directory);
  for (;;) { result.push(current); const parent = path.dirname(current); if (parent === current) return result; current = parent; }
}
export function resolveRuntime({ root, cwd = process.cwd(), env = process.env, entryUrl = import.meta.url } = {}) {
  const explicit = root ?? env.GLINT_ROOT;
  if (explicit !== undefined) {
    const resolved = path.resolve(cwd, explicit);
    if (!hasRuntime(resolved)) throw new Error("Glint runtime 未找到：请用 --root 或 GLINT_ROOT 指定已安装依赖的源码仓库或完整便携包根目录。");
    return resolved;
  }
  const found = [...ancestors(cwd), ...ancestors(path.dirname(fileURLToPath(entryUrl)))].find(hasRuntime);
  if (!found) throw new Error("Glint runtime 未配置：请指定 --root 或 GLINT_ROOT；Skill 不会自动下载或修改全局配置。");
  return found;
}
export function invocation(argv, { cwd = process.cwd(), env = process.env, entryUrl = import.meta.url } = {}) {
  const args = []; let root;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") { root = argv[++i]; if (!root) throw new Error("--root requires a Glint runtime directory"); }
    else if (argv[i].startsWith("--root=")) { root = argv[i].slice(7); if (!root) throw new Error("--root requires a Glint runtime directory"); }
    else args.push(argv[i]);
  }
  root = resolveRuntime({ root, cwd, env, entryUrl });
  const app = isRuntime(root) ? undefined : portableApp(root);
  if (app) {
    if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("Glint 便携运行时需要 Node.js 22 或更高版本；完整包可使用包内 node.exe。");
    const entry = path.join(app, "cli", "glint.mjs"), studio = path.join(app, "studio");
    return { runtime: "portable", command: process.execPath, args: [entry, ...args], cwd: studio,
      env: { ...env, INIT_CWD: cwd, GLINT_STUDIO_DIR: studio, GLINT_CLI_ENTRY: entry,
        GLINT_MAKE_ENTRY: entry, GLINT_MAKE_NODE: process.execPath, GLINT_BUILD_FILE: path.join(app, "build.json"),
        GLINT_RUNTIME_ASSETS: path.join(app, "runtime-assets"), GLINT_PREBUILT_BUNDLE: path.join(app, "remotion-bundle"),
        GLINT_NLE_HARNESS: path.join(app, "cli", "nle-harness.js"), GLINT_DIRECT_BROWSER_HARNESS: path.join(app, "cli", "direct-browser.js") } };
  }
  const studio = path.join(root, "apps", "studio"), require = createRequire(path.join(studio, "package.json"));
  let loader;
  try { loader = require.resolve("tsx"); } catch { throw new Error("Glint runtime 缺少依赖，请在运行时仓库执行 pnpm install --frozen-lockfile。"); }
  return { runtime: "source", command: process.execPath, args: ["--import", pathToFileURL(loader).href, path.join(studio, "scripts", "glint.ts"), ...args], cwd: studio,
    env: { ...env, INIT_CWD: cwd, GLINT_STUDIO_DIR: studio, GLINT_CLI_ENTRY: undefined } };
}
async function main() {
  const argv = process.argv.slice(2), check = argv.includes("--runtime-check");
  const run = invocation(argv.filter(arg => arg !== "--runtime-check"));
  if (check) { process.stdout.write(JSON.stringify({ ready: true, runtime: run.runtime, desktopRequired: false }) + "\n"); return; }
  await new Promise((resolve, reject) => {
    const child = spawn(run.command, run.args, { cwd: run.cwd, env: run.env, shell: false, stdio: "inherit", windowsHide: true });
    child.once("error", reject); child.once("close", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); resolve(); });
  });
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
