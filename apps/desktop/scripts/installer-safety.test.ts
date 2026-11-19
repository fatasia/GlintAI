import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

it.skipIf(process.platform !== "win32")("upgrade and uninstall preserve projects and reject unrelated folders", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "glint-installer-test-"));
  const source = path.join(root, "package"), target = path.join(root, "install"), unrelated = path.join(root, "unrelated");
  const installer = path.join(import.meta.dirname, "installer", "Install-Glint.ps1");
  const uninstall = path.join(import.meta.dirname, "installer", "Uninstall-Glint.ps1");
  const run = (script: string, ...args: string[]) => spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args], { encoding: "utf8" });
  const file = (name: string, content: string) => { const destination = path.join(source, name); mkdirSync(path.dirname(destination), { recursive: true }); writeFileSync(destination, content); };
  try {
    file("Glint.cmd", "launcher"); file("Glint.exe", "binary"); file("app/server/service.mjs", "service"); file("app/cli/glint.mjs", "cli");
    file("skills/writing/SKILL.md", "packaged original");
    file("app/studio/out/project.json", "packaged output must not overwrite user data");
    mkdirSync(unrelated); writeFileSync(path.join(unrelated, "important.txt"), "leave me");
    const args = ["-Source", source, "-Target", target, "-NoShortcuts", "-NoRegistry", "-NoLaunch"];
    expect(run(installer, ...args).status).toBe(0);
    expect(existsSync(path.join(target, "app", "studio", "out"))).toBe(true);
    const project = path.join(target, "app", "studio", "out", "project.json");
    mkdirSync(path.dirname(project), { recursive: true }); writeFileSync(project, "my project");
    const skill = path.join(target, "skills", "writing", "SKILL.md");
    expect(readFileSync(skill, "utf8")).toBe("packaged original");
    writeFileSync(skill, "my edits"); file("skills/writing/SKILL.md", "new packaged version");
    file("skills/new-skill/SKILL.md", "new skill");
    expect(run(installer, ...args).status).toBe(0);
    expect(readFileSync(project, "utf8")).toBe("my project");
    expect(readFileSync(skill, "utf8")).toBe("my edits");
    expect(readFileSync(path.join(target, "skills", "new-skill", "SKILL.md"), "utf8")).toBe("new skill");
    expect(run(installer, "-Source", source, "-Target", unrelated, "-NoShortcuts", "-NoRegistry", "-NoLaunch").status).not.toBe(0);
    expect(readFileSync(path.join(unrelated, "important.txt"), "utf8")).toBe("leave me");
    expect(run(uninstall, "-Target", target, "-NoShortcuts", "-NoRegistry").status).toBe(0);
    expect(readFileSync(project, "utf8")).toBe("my project");
    expect(readFileSync(skill, "utf8")).toBe("my edits");
    expect(existsSync(path.join(target, "Glint.exe"))).toBe(false);
  } finally {
    if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("unsafe temporary path");
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
