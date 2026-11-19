import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { expect, it } from "vitest";
import { copyDesktopServiceDependencies } from "./portable-dependencies.mjs";

it("relocates the complete jsdom runtime without pnpm links, workspace resolution or overwriting an existing package", async () => {
  const root = mkdtempSync(join(tmpdir(), "glint-service-runtime-"));
  try {
    const receipts = copyDesktopServiceDependencies(resolve(import.meta.dirname, "../../.."), root);
    expect(receipts.some(item => item.name === "jsdom" && item.version === "30.1.3")).toBe(true);
    const script = `const path=require('node:path');const entry=require.resolve('jsdom');if(!entry.startsWith(process.cwd()+path.sep))throw Error('resolved outside package');const {JSDOM}=require('jsdom');const dom=new JSDOM('<main><p data-test="title">中文设计</p></main>');console.log(dom.window.document.querySelector('[data-test="title"]').textContent);dom.window.close();`;
    const result = await promisify(execFile)(process.execPath, ["-e", script], {
      cwd: root, windowsHide: true, timeout: 15000,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: root, TMP: root },
    });
    expect(result.stdout.trim()).toBe("中文设计"); expect(result.stderr).toBe("");
    const manifest = join(root, "node_modules/jsdom/package.json"), before = readFileSync(manifest, "utf8");
    expect(() => copyDesktopServiceDependencies(resolve(import.meta.dirname, "../../.."), root)).toThrow("already exists");
    expect(readFileSync(manifest, "utf8")).toBe(before);
  } finally {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("unsafe temporary runtime directory");
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
