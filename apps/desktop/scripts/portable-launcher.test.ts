import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { portableLauncher } from "./portable-launcher.mjs";

it.skipIf(process.platform !== "win32")("resolves launcher paths after moving the package", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "glint-launcher-test-"));
  try {
    const initial = path.join(root, "original");
    const moved = path.join(root, "移动 package");
    mkdirSync(initial);
    const script = portableLauncher({ lite: false, buildId: "test" }).replace('start "" "%~dp0Glint.exe"', 'chcp 65001 >nul\r\necho CHECK_REPO=%GLINT_DESKTOP_REPO%\r\necho CHECK_NODE=%GLINT_DESKTOP_NODE%\r\necho CHECK_BUNDLE=%GLINT_PREBUILT_BUNDLE%\r\necho CHECK_RUNTIME=%GLINT_RUNTIME_ASSETS%\r\necho CHECK_DIRECT=%GLINT_DIRECT_BROWSER_HARNESS%');
    writeFileSync(path.join(initial, "Glint.cmd"), script);
    renameSync(initial, moved);
    const result = spawnSync("cmd.exe", ["/d", "/c", "Glint.cmd"], { cwd: moved, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`CHECK_REPO=${path.join(moved, "app")}`);
    expect(result.stdout).toContain(`CHECK_NODE=${path.join(moved, "node.exe")}`);
    expect(result.stdout).toContain(`CHECK_BUNDLE=${path.join(moved, "app", "remotion-bundle")}`);
    expect(result.stdout).toContain(`CHECK_RUNTIME=${path.join(moved, "app", "runtime-assets")}`);
    expect(result.stdout).toContain(`CHECK_DIRECT=${path.join(moved, "app", "cli", "direct-browser.js")}`);
    expect(result.stdout).not.toContain(initial);
  } finally {
    if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("unsafe temporary path");
    rmSync(root, { recursive: true, force: true });
  }
});

it("keeps both launchers location-independent and shortcuts use the launcher", () => {
  const lite = portableLauncher({ lite: true, buildId: "test" });
  expect(lite).toContain('set "GLINT_MAKE_NODE=%GLINT_DESKTOP_NODE%"');
  expect(lite).toContain("where node");
  expect(readFileSync(path.join(import.meta.dirname, "installer", "Install-Glint.ps1"), "utf8")).toContain('$shortcut.TargetPath = (Join-Path $target "Glint.cmd")');
});
