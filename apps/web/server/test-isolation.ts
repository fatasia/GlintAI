import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect } from "vitest";

// Setup runs before static imports, including tests outside apps/web that import the server.
const testPath = expect.getState().testPath;
if (!testPath) throw new Error("Cannot determine the test file for data isolation");
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-web-test-"));
  const original = { ...process.env };
  const temp = path.join(root, "temp");
  const studio = path.join(root, "apps", "studio");
  fs.mkdirSync(temp);
  if (process.env.GLINT_TEST_REAL_STUDIO === "1") {
    const source = path.resolve("apps/studio");
    fs.mkdirSync(studio, { recursive: true });
    for (const entry of ["scripts", "src", "package.json", "remotion.config.ts"]) {
      fs.cpSync(path.join(source, entry), path.join(studio, entry), { recursive: true });
    }
    fs.cpSync(path.resolve("packages/video/src"), path.join(root, "packages/video/src"), { recursive: true });
    fs.symlinkSync(path.join(source, "node_modules"), path.join(studio, "node_modules"), "junction");
    if (process.env.GLINT_TEST_STYLE_FIXTURES === "1") {
      fs.cpSync(path.resolve("outputs/style-samples"), path.join(root, "styles"), { recursive: true });
    }
  }
  Object.assign(process.env, {
    GLINT_DATA_DIR: path.join(root, "data"),
    GLINT_SESSION_DIR: path.join(root, "sessions"),
    GLINT_CACHE_DIR: path.join(root, "cache"),
    GLINT_STUDIO_DIR: studio,
    GLINT_STYLE_SAMPLE_DIR: path.join(root, "styles"),
    TEMP: temp, TMP: temp, TMPDIR: temp,
  });
  afterAll(async () => {
    for (const key of ["GLINT_DATA_DIR", "GLINT_SESSION_DIR", "GLINT_CACHE_DIR", "GLINT_STUDIO_DIR", "GLINT_STYLE_SAMPLE_DIR", "TEMP", "TMP", "TMPDIR"]) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
    // Edge can release its per-test temp files asynchronously after the browser exits.
    // Retry only transient filesystem errors and always surface the final failure.
    const deadline = Date.now() + 15_000;
    for (;;) {
      try {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (!["EPERM", "EBUSY", "ENOTEMPTY"].includes(code ?? "") || Date.now() >= deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
  }, 20_000);
}
