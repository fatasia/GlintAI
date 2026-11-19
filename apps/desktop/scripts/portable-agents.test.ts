import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { buildDesktopAgentAdapters } from "./portable-agents.mjs";

const execute = promisify(execFile);
it("packages both official adapters as standalone programs without a workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "glint-agent-portable-"));
  try {
    await buildDesktopAgentAdapters(resolve(import.meta.dirname, "../../.."), root);
    for (const [name, version] of [["claude", "0.99.1"], ["codex", "2.5.0"]]) {
      const result = await execute(process.execPath, [join(root, `${name}.mjs`), "--version"], {
        cwd: root, timeout: 15000, windowsHide: true,
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: root, TMP: root },
      });
      expect(result.stdout).toContain(version);
      expect(readFileSync(join(root, `${name}.LICENSE`), "utf8")).toContain("Apache");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60000);
