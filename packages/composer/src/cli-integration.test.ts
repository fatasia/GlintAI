import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import os from "node:os";

const entry = new URL("../../../apps/studio/scripts/glint.ts", import.meta.url);
const require = createRequire(entry);
const run = promisify(execFile);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|TOKEN|SECRET|PASSWORD|INIT_CWD/i.test(key)));

describe("CLI real child process, no credentials or paid services", () => {
  it("starts from an unrelated cwd", async () => {
    const result = await run(process.execPath, ["--import", pathToFileURL(require.resolve("tsx")).href, fileURLToPath(entry), "help"], { cwd: os.tmpdir(), env, timeout: 15000 });
    expect(result.stdout).toContain("pnpm glint make");
  });
  it("resolves source relative to INIT_CWD and preserves shell metacharacters", async () => {
    const filename = "不存在 space & whoami;$(bad).md";
    const error = await run(process.execPath, ["--import", pathToFileURL(require.resolve("tsx")).href, fileURLToPath(entry), "make", `--source=${filename}`, "--engine=heuristic"], {
      cwd: os.tmpdir(), env: { ...env, INIT_CWD: os.tmpdir() }, timeout: 15000,
    }).catch((error: Error & { stderr: string }) => error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error & { stderr: string }).stderr).toContain(path.join(os.tmpdir(), filename));
  });
  it("reaches the real render script with Studio cwd and propagates its exit status", async () => {
    const error = await run(process.execPath, ["--import", pathToFileURL(require.resolve("tsx")).href, fileURLToPath(entry), "render", "--encoding=not-a-preset"], { cwd: os.tmpdir(), env, timeout: 15000 })
      .catch((error: Error & { stderr: string }) => error);
    expect(error).toBeInstanceOf(Error);
    const stderr = (error as Error & { stderr: string }).stderr;
    expect(stderr).toMatch(/encoding/i);
    expect(stderr).toContain("command exited: 1");
    expect(stderr).not.toContain("Cannot find module");
  });
});
