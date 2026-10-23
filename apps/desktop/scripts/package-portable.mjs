import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

/**
 * Local build of the desktop app.
 *  - default: self-contained (bundled Node runtime) — works with no prerequisites.
 *  - --lite:  skip the runtime and use system Node.js 22+ — smaller download.
 * Rendering still uses system FFmpeg/Chrome; service, CLI and UI are bundled.
 */
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(desktop, "..", "..");
const exe = join(desktop, "target", "release", "glint-desktop.exe");
const webDist = join(repo, "apps", "web", "dist");
const lite = process.argv.includes("--lite");
const out = join(repo, "dist-portable", lite ? "Glint-lite" : "Glint");
const app = join(out, "app");
const check = process.argv.includes("--check");
const nonce = "portable-smoke-0123456789abcdef";
const nodePath = lite ? "node" : join(out, "node.exe");
const ESM_SHIM = `import { createRequire as __glintCreateRequire } from "node:module";\nimport { fileURLToPath as __glintFileURLToPath } from "node:url";\nconst require = __glintCreateRequire(import.meta.url);\nconst __filename = __glintFileURLToPath(import.meta.url);\nconst __dirname = __filename.slice(0, Math.max(__filename.lastIndexOf("/"), __filename.lastIndexOf("\\\\")));`;

if (!existsSync(join(webDist, "index.html"))) throw new Error("Build the web UI first: pnpm --filter glint-web build");
if (!existsSync(exe)) throw new Error("Build the desktop host first: cargo build --release --manifest-path apps/desktop/Cargo.toml");

mkdirSync(join(app, "server"), { recursive: true });
mkdirSync(join(app, "cli"), { recursive: true });
mkdirSync(join(app, "studio", "out"), { recursive: true });
cpSync(webDist, join(app, "web"), { recursive: true });
cpSync(exe, join(out, "Glint.exe"));
if (!lite) cpSync(process.execPath, join(out, "node.exe"));

await build({ entryPoints: [join(repo, "apps/web/server/desktop-service.mjs")], outfile: join(app, "server", "service.mjs"),
  bundle: true, platform: "node", format: "esm", target: "node22",
  // Workspace packages resolve from their source entries via pnpm links; keep resvg native.
  alias: {
    "@glintai/session": join(repo, "packages/session/src/index.ts"),
    "@glintai/session/node": join(repo, "packages/session/src/node.ts"),
    "@glintai/scenescript": join(repo, "packages/scenescript/src/index.ts"),
  },
  external: ["@resvg/resvg-js"], logLevel: "warning" });
// The CLI bundle must not embed Remotion's bundler: it pulls webpack/rspack and
// native bindings. Packaged renders use the pre-generated bundle instead.
await build({ entryPoints: [join(repo, "apps/studio/scripts/glint.ts")], outfile: join(app, "cli", "glint.mjs"),
  bundle: true, platform: "node", format: "esm", target: "node22", external: ["@resvg/resvg-js", "@remotion/bundler"], logLevel: "warning", banner: { js: ESM_SHIM } });
// Worker entries are siblings of the CLI so packaged builds spawn them directly
// (no tsx, no TypeScript sources on disk). The composite npm package stays
// external: it exposes a native .dir with remotion.exe/ffmpeg.exe.
await build({ entryPoints: [join(repo, "apps/studio/scripts/render.ts")], outfile: join(app, "cli", "render.mjs"),
  bundle: true, platform: "node", format: "esm", target: "node22",
  external: ["@resvg/resvg-js", "@remotion/bundler", "@remotion/compositor-win32-x64-msvc"],
  logLevel: "warning", banner: { js: ESM_SHIM } });

// Native SVGs need resvg; copy its JS wrapper and the Windows binding.
for (const entry of readdirSync(join(repo, "node_modules", ".pnpm")).filter(name => name.startsWith("@resvg+resvg-js"))) {
  const source = join(repo, "node_modules", ".pnpm", entry, "node_modules", "@resvg");
  cpSync(source, join(app, "node_modules", "@resvg"), { recursive: true });
}
// Remotion's renderer loads the platform compositor by package name at runtime.
for (const entry of readdirSync(join(repo, "node_modules", ".pnpm")).filter(name => name.startsWith("@remotion+compositor-win32-x64-msvc@"))) {
  const source = join(repo, "node_modules", ".pnpm", entry, "node_modules", "@remotion", "compositor-win32-x64-msvc");
  cpSync(source, join(app, "node_modules", "@remotion", "compositor-win32-x64-msvc"), { recursive: true });
}

// Pre-generate the Remotion composition bundle while the repo's bundler is
// available; the package itself has no webpack/rspack and only serves this.
const prebuiltBundle = join(app, "remotion-bundle");
{
  const studioRequire = createRequire(join(repo, "apps/studio/package.json"));
  const { bundle } = await import(pathToFileURL(studioRequire.resolve("@remotion/bundler")).href);
  rmSync(prebuiltBundle, { recursive: true, force: true });
  await bundle({ entryPoint: join(repo, "apps/studio/src/index.ts"), outDir: prebuiltBundle });
  if (!existsSync(join(prebuiltBundle, "index.html"))) throw new Error("Prebuilt Remotion bundle is missing index.html");
}

const version = JSON.parse(await import("node:fs/promises").then(fs => fs.readFile(join(repo, "package.json"), "utf8"))).version;
const commit = spawnSync("git", ["-C", repo, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).stdout?.trim() || "unknown";
writeFileSync(join(app, "build.json"), JSON.stringify({ version, commit, builtAt: new Date().toISOString(), mode: lite ? "lite" : "full" }, null, 2));

const env = {
  GLINT_BUILD_FILE: join(app, "build.json"), GLINT_DESKTOP_NODE: nodePath, GLINT_DESKTOP_REPO: app, GLINT_DESKTOP_SERVICE: join(app, "server", "service.mjs"),
  GLINT_WEB_DIST: join(app, "web"), GLINT_STUDIO_DIR: join(app, "studio"),
  GLINT_MAKE_ENTRY: join(app, "cli", "glint.mjs"), GLINT_MAKE_NODE: nodePath,
  GLINT_CLI_ENTRY: join(app, "cli", "glint.mjs"), GLINT_PREBUILT_BUNDLE: prebuiltBundle, GLINT_BUILD_ID: new Date().toISOString(),
};
const nodeLines = lite ? [
  "set \"GLINT_DESKTOP_NODE=\"",
  "for /f \"delims=\" %%i in ('where node 2^>nul') do set \"GLINT_DESKTOP_NODE=%%i\"",
  "if not defined GLINT_DESKTOP_NODE (echo Node.js 22+ is required for the lite build. Install Node or use the full build. & exit /b 1)",
] : [];
writeFileSync(join(out, "Glint.cmd"), [
  "@echo off",
  lite ? "rem Lite build: uses system Node.js 22+; no private runtime is bundled." : "rem Full build: bundled service/CLI/UI with a private Node runtime.",
  ...nodeLines,
  ...Object.entries(env).filter(([key]) => !(lite && (key === "GLINT_DESKTOP_NODE" || key === "GLINT_MAKE_NODE")))
    .map(([key, value]) => `set "${key}=${value}"`),
  "start \"\" \"%~dp0Glint.exe\"",
  "",
].join("\r\n"));
writeFileSync(join(out, "README.txt"), [
  lite ? "Glint 轻量本地包" : "Glint 完整本地包",
  "",
  "运行：双击 Glint.cmd（免安装）；或双击 Install-Glint.cmd 安装到 %LOCALAPPDATA%\\\\Glint 并创建快捷方式。",
  lite ? "包含：桌面宿主、打包后的服务与 CLI、Web UI；使用系统 Node.js 22+。" : "包含：桌面宿主、内置 Node、打包后的服务与 CLI、Web UI。",
  "仍需系统已安装 FFmpeg 与 WebView2；HTML/图片/视频场景需要系统 Chrome。",
  "数据目录：%LOCALAPPDATA%\\Glint；输出目录：app\\studio\\out。",
  "卸载：删除本文件夹。",
  "",
].join("\r\n"));

// Per-user installer: copies the package, creates shortcuts and an uninstall entry.
const installerDir = join(out, "installer");
mkdirSync(installerDir, { recursive: true });
cpSync(join(desktop, "scripts", "installer", "Install-Glint.ps1"), join(installerDir, "Install-Glint.ps1"));
cpSync(join(desktop, "scripts", "installer", "Uninstall-Glint.ps1"), join(installerDir, "Uninstall-Glint.ps1"));
writeFileSync(join(out, "Install-Glint.cmd"), [
  "@echo off",
  "chcp 65001 >nul",
  "powershell -NoProfile -ExecutionPolicy Bypass -File \"%~dp0installer\\Install-Glint.ps1\" -Source \"%~dp0\"",
  "pause",
  "",
].join("\r\n"));

if (process.argv.includes("--zip")) {
  const archive = join(repo, "dist-portable", `${lite ? "Glint-lite" : "Glint"}.zip`);
  const zipped = spawnSync("powershell", ["-NoProfile", "-Command",
    `Compress-Archive -Path '${out}\\*' -DestinationPath '${archive}' -Force`], { stdio: "inherit" });
  if (zipped.status !== 0) throw new Error("Compress-Archive failed");
  console.log(`zip: ${archive}`);
}

if (check) {
  const dataDir = join(out, ".smoke-data");
  mkdirSync(dataDir, { recursive: true });
  const service = spawn(lite ? process.execPath : join(out, "node.exe"), [join(app, "server", "service.mjs"), `--data-dir=${dataDir}`, `--nonce=${nonce}`],
    { cwd: app, env: { ...process.env, ...env, GLINT_JOB_DEBUG: "1" }, stdio: ["pipe", "pipe", "pipe"] });
  const ready = await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => { service.kill(); reject(new Error("Packaged service did not become ready in 30s")); }, 30_000);
    let buffer = "";
    service.stdout.on("data", chunk => {
      buffer += String(chunk);
      const line = buffer.split(/\r?\n/).find(value => value.includes(`"nonce":"${nonce}"`));
      if (line) { clearTimeout(timer); resolveReady(JSON.parse(line.slice(line.indexOf("{")))); }
    });
    service.stderr.on("data", chunk => { buffer += String(chunk); });
    service.once("exit", code => { clearTimeout(timer); reject(new Error(`Packaged service exited early (${code}): ${buffer.slice(-300)}`)); });
  });
  const health = await fetch(`${ready.url}/api/health`);
  if (!health.ok) throw new Error(`Packaged service health check failed: ${health.status} ${await health.text().then(value => value.slice(0, 200)).catch(() => "")}`);
  const healthBody = await health.json();
  if (!healthBody?.build?.version || !healthBody?.build?.commit) throw new Error("Packaged service did not report build identity");
  const submitted = await (await fetch(`${ready.url}/api/make`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: "第一节：把资料变成分镜。第二节：本地渲染一条无声草稿，验证完整交付链路。", tts: "mock", music: "off", encoding: "draft" }) })).json();
  if (!submitted?.jobId) throw new Error(`Packaged render was rejected: ${JSON.stringify(submitted).slice(0, 300)}`);
  let job = null;
  for (let attempt = 0; attempt < 120; attempt++) {
    await new Promise(done => setTimeout(done, 2000));
    job = await (await fetch(`${ready.url}/api/make/${submitted.jobId}`)).json();
    if (["done", "failed", "cancelled"].includes(job.status)) break;
  }
  if (job?.status !== "done") throw new Error(`Packaged render failed: ${JSON.stringify(job).slice(0, 400)}`);
  const composed = await (await fetch(`${ready.url}/api/make/${submitted.jobId}/project`)).json();
  if (!Array.isArray(composed?.project?.scenes) || !composed.project.scenes.length) throw new Error("Packaged app could not return the composed project");
  const ui = await (await fetch(`${ready.url}/`)).text();
  if (!/<!doctype html/i.test(ui)) throw new Error("Packaged app did not serve the web UI");
  service.stdin.write(JSON.stringify({ type: "shutdown", nonce }) + "\n");
  service.stdin.end();
  console.log(JSON.stringify({ output: out, mode: lite ? "lite" : "full", service: "ready", render: job.status, scenes: composed.project.scenes.length, ui: "served" }, null, 2));
} else {
  console.log(JSON.stringify({ output: out, mode: lite ? "lite" : "full", note: "Run with --check to smoke-test startup and a full draft render." }, null, 2));
}
