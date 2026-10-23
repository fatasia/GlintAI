import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Exercises the per-user installer without touching shortcuts or the registry. */
const root = path.resolve(import.meta.dirname, "..", "..", "..");
const packageDir = path.join(root, "dist-portable", process.argv.includes("--lite") ? "Glint-lite" : "Glint");
const target = mkdtempSync(path.join(os.tmpdir(), "glint-install-check-"));
const powershell = args => spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", ...args], { encoding: "utf8" });

try {
  for (const file of ["Glint.exe", "Glint.cmd", "app/server/service.mjs", "app/cli/glint.mjs", "installer/Install-Glint.ps1", "installer/Uninstall-Glint.ps1"]) {
    if (!existsSync(path.join(packageDir, file))) throw new Error(`Package is missing ${file}; run pnpm desktop:package first`);
  }
  const install = powershell(["-File", path.join(packageDir, "installer", "Install-Glint.ps1"), "-Source", packageDir, "-Target", target, "-NoShortcuts", "-NoRegistry", "-NoLaunch"]);
  if (install.status !== 0) throw new Error(`Install failed: ${install.stderr || install.stdout}`);
  for (const file of ["Glint.exe", "Glint.cmd", "app/server/service.mjs", "Uninstall-Glint.ps1"]) {
    if (!existsSync(path.join(target, file))) throw new Error(`Installed tree is missing ${file}`);
  }
  const uninstall = powershell(["-File", path.join(target, "Uninstall-Glint.ps1"), "-Target", target, "-NoShortcuts", "-NoRegistry"]);
  if (uninstall.status !== 0) throw new Error(`Uninstall failed: ${uninstall.stderr || uninstall.stdout}`);
  const deadline = Date.now() + 10_000;
  while (existsSync(target) && Date.now() < deadline) spawnSync(process.execPath, ["-e", "setTimeout(()=>{},300)"]);
  if (existsSync(target)) throw new Error("Uninstall left files behind");
  console.log(JSON.stringify({ installer: "ok", target, packageDir }, null, 2));
} finally {
  rmSync(target, { recursive: true, force: true });
}
