import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const repo = fileURLToPath(new URL("../", import.meta.url));
if (process.argv.slice(2).some((arg) => arg !== "--online")) throw new Error("Only --online is supported");
const online = process.argv.includes("--online");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "glint-install-check-"));
const list = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: repo, windowsHide: true });
if (list.status !== 0) throw new Error("Source inventory requires Git");
const files = [...new Set(list.stdout.toString("utf8").split("\0").filter(Boolean))];
for (const file of files) {
  const source = path.resolve(repo, file), destination = path.resolve(out, file);
  if (!source.startsWith(repo) || !destination.startsWith(`${out}${path.sep}`)) throw new Error("Source path escaped workspace");
  const stat = fs.lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unexpected source entry");
  fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.copyFileSync(source, destination);
}
const report = { status: "running", output: out, files: files.length, node: process.version, platform: process.platform, online, commands: [] };
try {
  for (const args of [["install", ...(online ? [] : ["--offline"]), "--frozen-lockfile", "--ignore-scripts"], ["typecheck"], ["test"], ["--filter", "glint-web", "build"]]) {
    const start = performance.now();
    // Only fixed tool arguments enter this shell; no document text or paths are interpolated.
    const result = process.platform === "win32"
      ? spawnSync("cmd.exe", ["/d", "/s", "/c", ["pnpm", ...args].join(" ")], { cwd: out, windowsHide: true, shell: false, encoding: "utf8", maxBuffer: 10 * 1024 * 1024, timeout: 300_000 })
      : spawnSync("pnpm", args, { cwd: out, shell: false, encoding: "utf8", maxBuffer: 10 * 1024 * 1024, timeout: 300_000 });
    fs.writeFileSync(path.join(out, `verify-${report.commands.length}.log`), result.stdout + result.stderr);
    report.commands.push({ args, code: result.status, elapsedMs: performance.now() - start });
    if (result.error || result.status !== 0) throw new Error(`Fresh-directory check failed: pnpm ${args.join(" ")}; see ${out}`);
  }
  report.status = "passed";
  console.log(`[install] ${online ? "registry-enabled" : "offline"} fresh directory passed; this reused the local pnpm store, not a clean machine: ${out}`);
} catch (error) { report.status = "failed"; report.error = String(error); throw error; }
finally { fs.writeFileSync(path.join(out, "verify-report.json"), JSON.stringify(report, null, 2)); }
