import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { portableLauncher, chapterLauncher } from "./portable-launcher.mjs";
import { desktopServiceBuildOptions, portableChapterBuildOptions, localChapterToolBuildOptions, esmNodeShim } from "./portable-service-build.mjs";
import { createPortableOutput } from "./portable-output.mjs";
import { createPortableArchive } from "./portable-archive.mjs";
import { buildDesktopAgentAdapters } from "./portable-agents.mjs";
import { copyDesktopServiceDependencies } from "./portable-dependencies.mjs";
import { verifyPackagedWebUi } from "./portable-ui-check.mjs";

/**
 * Local build of the desktop app.
 *  - default: self-contained (bundled Node runtime) — works with no prerequisites.
 *  - --lite:  skip the runtime and use system Node.js 22+ — smaller download.
 * Rendering still uses system FFmpeg/Chrome; service, CLI and UI are bundled.
 */
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(desktop, "..", "..");
const exe = process.env.GLINT_DESKTOP_HOST_EXE ? resolve(process.env.GLINT_DESKTOP_HOST_EXE) : join(desktop, "target", "release", "glint-desktop.exe");
const webDist = process.env.GLINT_PORTABLE_WEB_DIST ? resolve(process.env.GLINT_PORTABLE_WEB_DIST) : join(repo, "apps", "web", "dist");
const lite = process.argv.includes("--lite");
const out = process.env.GLINT_PORTABLE_OUTPUT ? resolve(process.env.GLINT_PORTABLE_OUTPUT) : join(repo, "dist-portable", lite ? "Glint-lite" : "Glint");
const app = join(out, "app");
const check = process.argv.includes("--check");
const zip = process.argv.includes("--zip");
const archive = zip ? resolve(process.env.GLINT_PORTABLE_ARCHIVE ?? join(repo, "dist-portable", `${lite ? "Glint-lite" : "Glint"}.zip`)) : undefined;
const nonce = "portable-smoke-0123456789abcdef";
const nodePath = lite ? "node" : join(out, "node.exe");
const ESM_SHIM = esmNodeShim;

if (!existsSync(join(webDist, "index.html"))) throw new Error("Build the web UI first: pnpm --filter glint-web build");
if (!existsSync(exe)) throw new Error("Build the desktop host first: cargo build --release --manifest-path apps/desktop/Cargo.toml");
const secureManifest = join(desktop, "secure-assets", "Cargo.toml");
const secureBuild = spawnSync("cargo", ["build", "--locked", "--release", "--manifest-path", secureManifest], { cwd: repo, stdio: "inherit", windowsHide: true });
if (secureBuild.error || secureBuild.status !== 0) throw new Error("Failed to build secure assets bridge", { cause: secureBuild.error });
const secureBridge = join(process.env.CARGO_TARGET_DIR ? resolve(process.env.CARGO_TARGET_DIR) : join(desktop, "secure-assets", "target"), "release", "glint-secure-assets.exe");
if (!existsSync(secureBridge)) throw new Error("Secure assets bridge binary is missing");
createPortableOutput(out, archive);

mkdirSync(join(app, "server"), { recursive: true });
mkdirSync(join(app, "cli"), { recursive: true });
mkdirSync(join(app, "studio", "out"), { recursive: true });
const cutoutScript = join(repo, "apps", "web", "server", "local-cutout.py");
if (existsSync(cutoutScript)) cpSync(cutoutScript, join(app, "server", "local-cutout.py"));
cpSync(webDist, join(app, "web"), { recursive: true });
cpSync(exe, join(out, "Glint.exe"));
cpSync(secureBridge, join(app, "server", "glint-secure-assets.exe"));
if (!lite) cpSync(process.execPath, join(out, "node.exe"));

// The service reads the skills directory beside the app folder. Resolve
// installed junctions when packaging so the copied package works on another PC.
const skillsSource = join(repo, "skills"), skillsDestination = join(out, "skills");
if (existsSync(skillsSource)) {
  mkdirSync(skillsDestination, { recursive: true });
  for (const name of readdirSync(skillsSource)) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) continue;
    const source = join(skillsSource, name);
    if (statSync(source).isDirectory()) cpSync(source, join(skillsDestination, name), { recursive: true, dereference: true });
  }
}
if (existsSync(join(repo, "skills-lock.json"))) cpSync(join(repo, "skills-lock.json"), join(out, "skills-lock.json"));

copyDesktopServiceDependencies(repo, app);
await build(desktopServiceBuildOptions(repo, join(app, "server", "service.mjs")));
await buildDesktopAgentAdapters(repo, join(app, "server", "agents"));
await build(portableChapterBuildOptions(repo, join(app, "server", "portable-chapter-adapter.mjs")));
await build(localChapterToolBuildOptions(repo, join(app, "cli", "local-chapter-tool.mjs")));
// The CLI bundle must not embed Remotion's bundler: it pulls webpack/rspack and
// native bindings. Packaged renders use the pre-generated bundle instead.
await build({ entryPoints: [join(repo, "apps/studio/scripts/glint.ts")], outfile: join(app, "cli", "glint.mjs"),
  bundle: true, platform: "node", format: "esm", target: "node22", external: ["@resvg/resvg-js", "@remotion/bundler"], logLevel: "warning", banner: { js: ESM_SHIM } });
// The local image editor serves a browser runtime, not TypeScript source from the repository.
await build({ stdin: { contents: 'import { editRuntime } from "./edit-studio/runtime"; editRuntime();',
  resolveDir: join(repo, "apps/studio/scripts"), loader: "ts" }, outfile: join(app, "cli", "edit-studio", "runtime.js"),
  bundle: true, platform: "browser", format: "iife", target: "chrome120", logLevel: "warning" });
// Worker entries are siblings of the CLI so packaged builds spawn them directly
// (no tsx, no TypeScript sources on disk). The composite npm package stays
// external: it exposes a native .dir with remotion.exe/ffmpeg.exe.
await build({ entryPoints: [join(repo, "apps/studio/scripts/render.ts")], outfile: join(app, "cli", "render.mjs"),
  bundle: true, platform: "node", format: "esm", target: "node22",
  external: ["@resvg/resvg-js", "@remotion/bundler", "@remotion/compositor-win32-x64-msvc"],
  logLevel: "warning", banner: { js: ESM_SHIM } });

// NLE renderer: browser capture + ffmpeg. esbuild stays external and is only
// reached in development; the packaged path reads the pre-bundled harness.
await build({ entryPoints: [join(repo, "apps/studio/scripts/nle-render.ts")], outfile: join(app, "cli", "nle-render.mjs"),
  bundle: true, platform: "node", format: "esm", target: "node22", external: ["esbuild"], logLevel: "warning", banner: { js: ESM_SHIM } });
await build({ entryPoints: [join(repo, "apps/studio/scripts/nle-capture-page.ts")], outfile: join(app, "cli", "nle-harness.js"),
  bundle: true, platform: "browser", format: "iife", target: "chrome120", logLevel: "warning" });

// Prebuild browser capture and its runtime assets; installed packages and TS
// sources are deliberately absent on the destination machine.
const runtimeAssets = join(app, "runtime-assets");
const studioRequire = createRequire(join(repo, "apps/studio/package.json"));
const decoderBuild = spawnSync(process.execPath, ["--import", pathToFileURL(studioRequire.resolve("tsx")).href, join(repo, "apps/studio/scripts/decoders.ts"), `--public=${runtimeAssets}`], { cwd: repo, stdio: "inherit", windowsHide: true, env: { ...process.env, GLINT_RUNTIME_ASSETS: "" } });
if (decoderBuild.error || decoderBuild.status !== 0) throw new Error("Failed to stage portable runtime assets", { cause: decoderBuild.error });
const directBundle = await build({ entryPoints: [join(repo, "apps/studio/scripts/direct-browser/page.ts")], outfile: join(app, "cli", "direct-browser.js"), bundle: true, platform: "browser", format: "iife", target: "es2020", minify: true, metafile: true, logLevel: "warning" });
if (Object.keys(directBundle.metafile.inputs).some(file => /node_modules[\\/].*remotion[\\/]/.test(file))) throw new Error("Independent backend unexpectedly bundled Remotion");

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
  if (existsSync(prebuiltBundle)) throw new Error("Prebuilt bundle path already exists");
  await bundle({ entryPoint: join(repo, "apps/studio/src/index.ts"), outDir: prebuiltBundle });
  if (!existsSync(join(prebuiltBundle, "index.html"))) throw new Error("Prebuilt Remotion bundle is missing index.html");
}

const version = JSON.parse(await import("node:fs/promises").then(fs => fs.readFile(join(repo, "package.json"), "utf8"))).version;
const commit = spawnSync("git", ["-C", repo, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).stdout?.trim() || "unknown";
const sourceStatus = spawnSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" });
const dirty = sourceStatus.status !== 0 || Boolean(sourceStatus.stdout?.trim());
writeFileSync(join(app, "build.json"), JSON.stringify({ version, commit, dirty, builtAt: new Date().toISOString(), mode: lite ? "lite" : "full" }, null, 2));

const env = {
  GLINT_BUILD_FILE: join(app, "build.json"), GLINT_DESKTOP_NODE: nodePath, GLINT_DESKTOP_REPO: app, GLINT_DESKTOP_SERVICE: join(app, "server", "service.mjs"),
  GLINT_WEB_DIST: join(app, "web"), GLINT_STUDIO_DIR: join(app, "studio"),
  GLINT_MAKE_ENTRY: join(app, "cli", "glint.mjs"), GLINT_MAKE_NODE: nodePath,
  GLINT_RUNTIME_ASSETS: runtimeAssets, GLINT_DIRECT_BROWSER_HARNESS: join(app, "cli", "direct-browser.js"),
  GLINT_CLI_ENTRY: join(app, "cli", "glint.mjs"), GLINT_PREBUILT_BUNDLE: prebuiltBundle, GLINT_NLE_HARNESS: join(app, "cli", "nle-harness.js"), GLINT_BUILD_ID: new Date().toISOString(),
};
writeFileSync(join(out, "Glint.cmd"), portableLauncher({ lite, buildId: env.GLINT_BUILD_ID }));
writeFileSync(join(out, "Glint-chapters.cmd"), chapterLauncher({ lite }));
writeFileSync(join(out, "README.txt"), [
  lite ? "Glint 轻量本地包" : "Glint 完整本地包",
  "",
  "运行：双击 Glint.cmd（免安装）；或双击 Install-Glint.cmd 安装到 %LOCALAPPDATA%\\\\Glint 并创建快捷方式。",
  lite ? "包含：桌面宿主、打包后的服务与 CLI、Web UI；使用系统 Node.js 22+。" : "包含：桌面宿主、内置 Node、打包后的服务与 CLI、Web UI。",
  "仍需系统已安装 FFmpeg 与 WebView2；HTML/图片/视频场景需要系统 Chrome。",
  "会话与素材：%APPDATA%\\ai.glint.desktop.dev；安装目录：%LOCALAPPDATA%\\Glint；输出目录：app\\studio\\out。",
  "本机含素材章节包：在命令提示符运行 Glint-chapters.cmd help，按说明先导出章节引用 JSON，再使用独立工具导出或恢复；不会通过网页开放迁移。",
  "卸载：安装版通过卸载程序移除程序文件并保留项目；删除便携包文件夹前请先备份其中的输出。",
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

if (zip) {
  createPortableArchive(out, archive);
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
  let uiCheck;
  try { uiCheck = await verifyPackagedWebUi(ready.url, repo); }
  catch (error) {
    service.stdin.write(JSON.stringify({ type: "shutdown", nonce }) + "\n"); service.stdin.end();
    throw error;
  }
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
  console.log(JSON.stringify({ output: out, mode: lite ? "lite" : "full", service: "ready", render: job.status, scenes: composed.project.scenes.length, ui: "served", uiCheck }, null, 2));
} else {
  console.log(JSON.stringify({ output: out, mode: lite ? "lite" : "full", note: "Run with --check to smoke-test startup and a full draft render." }, null, 2));
}
