import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Exercises the per-user installer without touching shortcuts or the registry. */
const root = path.resolve(import.meta.dirname, "..", "..", "..");
const packageDir = process.env.GLINT_PORTABLE_OUTPUT ? path.resolve(process.env.GLINT_PORTABLE_OUTPUT) : path.join(root, "dist-portable", process.argv.includes("--lite") ? "Glint-lite" : "Glint");
const target = mkdtempSync(path.join(os.tmpdir(), "glint-install-check-"));
const powershell = args => spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", ...args], { encoding: "utf8" });

try {
  for (const file of ["Glint.exe", "Glint.cmd", "app/server/service.mjs", "app/cli/glint.mjs", "installer/Install-Glint.ps1", "installer/Uninstall-Glint.ps1"]) {
    if (!existsSync(path.join(packageDir, file))) throw new Error(`Package is missing ${file}; run pnpm desktop:package first`);
  }
  const install = powershell(["-File", path.join(packageDir, "installer", "Install-Glint.ps1"), "-Source", packageDir, "-Target", target, "-NoShortcuts", "-NoRegistry", "-NoLaunch"]);
  if (install.status !== 0) throw new Error(`Install failed: ${install.stderr || install.stdout}`);
  for (const file of ["Glint.exe", "Glint.cmd", "app/server/service.mjs", "app/studio/out", "Uninstall-Glint.ps1"]) {
    if (!existsSync(path.join(target, file))) throw new Error(`Installed tree is missing ${file}`);
  }
  const saved = path.join(target, "app", "studio", "out", "user-project.json");
  mkdirSync(path.dirname(saved), { recursive: true });
  writeFileSync(saved, "keep my project");
  const upgrade = powershell(["-File", path.join(packageDir, "installer", "Install-Glint.ps1"), "-Source", packageDir, "-Target", target, "-NoShortcuts", "-NoRegistry", "-NoLaunch"]);
  if (upgrade.status !== 0 || readFileSync(saved, "utf8") !== "keep my project") throw new Error("Upgrade did not preserve user output");
  const uninstall = powershell(["-File", path.join(target, "Uninstall-Glint.ps1"), "-Target", target, "-NoShortcuts", "-NoRegistry"]);
  if (uninstall.status !== 0) throw new Error(`Uninstall failed: ${uninstall.stderr || uninstall.stdout}`);
  if (!existsSync(saved) || readFileSync(saved, "utf8") !== "keep my project") throw new Error("Uninstall did not preserve user output");
  if (existsSync(path.join(target, "Glint.exe"))) throw new Error("Uninstall left the installed executable");
  console.log(JSON.stringify({ installer: "ok", target, packageDir }, null, 2));
} finally {
  if (!path.resolve(target).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("unsafe temporary path");
  rmSync(target, { recursive: true, force: true });
}
