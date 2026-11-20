import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { environmentSnapshot, parseEnvironmentLock, verifyEnvironmentLock, type EnvironmentLock } from "./render-env";
import { ffmpegIdentity, fontFingerprint, nativeCacheEnvironment } from "./native-cache";

const CLI = fileURLToPath(new URL("./glint.ts", import.meta.url));
const scriptDir = path.dirname(CLI);

it("identifies the ffmpeg executable stably and includes it in the cache environment", () => {
  const first = ffmpegIdentity();
  if (first) {
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(ffmpegIdentity()).toBe(first);
  }
  const environment = nativeCacheEnvironment(scriptDir, { browserRequired: false, fontFiles: [] });
  expect(environment.ffmpeg).toBe(first || "missing");
  expect(environment.resvg).not.toBe("unknown");
  expect(environment.fontIdentity).toMatchObject({ mode: "system" });
});

it("reports render environment and per-family font availability through the CLI", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-render-env-"));
  try {
    const require = (await import("node:module")).createRequire(import.meta.url);
    const loader = (await import("node:url")).pathToFileURL(require.resolve("tsx")).href;
    const installedFamily = process.platform === "linux" ? "Noto Sans CJK SC" : "Arial";
    const json = execFileSync(process.execPath, ["--import", loader, CLI, "render-env", `--fonts=${installedFamily},Gl absolutely not a font`], { encoding: "utf8", timeout: 60_000, cwd: path.join(scriptDir, "..", "..", ".."), windowsHide: true });
    const parsed = JSON.parse(json.slice(json.indexOf("{"))) as { ffmpeg: string; browser: string; fonts: Array<{ family: string; available: boolean; via: string | null }>; fontsHash: string };
    expect(parsed.ffmpeg).not.toBe("missing");
    expect(parsed.browser).not.toBe("missing");
    expect(parsed.fonts).toEqual([
      { family: installedFamily, available: true, via: expect.any(String) },
      { family: "Gl absolutely not a font", available: false, via: null },
    ]);
    expect(parsed.fontsHash).toMatch(/^[0-9a-f]{16}$/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it("detects changed font bytes even with unchanged size and timestamp", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-font-hash-"));
  try {
    const font = path.join(root, "test.ttf");
    fs.writeFileSync(font, "aaaa");
    const time = new Date("2020-01-01T00:00:00Z");
    fs.utimesSync(font, time, time);
    const before = fontFingerprint([font], { systemFonts: false });
    fs.writeFileSync(font, "bbbb"); fs.utimesSync(font, time, time);
    expect(fontFingerprint([font], { systemFonts: false })).not.toEqual(before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it("creates and verifies a byte lock without overwriting user files", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-font-lock-"));
  try {
    const require = (await import("node:module")).createRequire(import.meta.url);
    const loader = (await import("node:url")).pathToFileURL(require.resolve("tsx")).href;
    const { spawnSync } = await import("node:child_process");
    const run = (...args: string[]) => spawnSync(process.execPath, ["--import", loader, CLI, "render-env", ...args], { cwd: root, encoding: "utf8", timeout: 60_000, windowsHide: true, env: { ...process.env, INIT_CWD: root } });
    fs.writeFileSync(path.join(root, "a.ttf"), "font-a");
    fs.writeFileSync(path.join(root, "b.otf"), "font-b");
    const create = run("--font-lock-create=lock.json", "--font-file=a.ttf", "--font-file=b.otf");
    expect(create.status).toBe(0);
    const original = fs.readFileSync(path.join(root, "lock.json"), "utf8");
    expect(JSON.parse(original).files).toHaveLength(2);
    expect(run("--font-lock-create=lock.json", "--font-file=a.ttf").status).not.toBe(0);
    expect(fs.readFileSync(path.join(root, "lock.json"), "utf8")).toBe(original);
    expect(run("--font-lock-verify=lock.json", "--font-file=b.otf", "--font-file=a.ttf").status).toBe(0);
    const missing = run("--font-lock-verify=lock.json", "--font-file=a.ttf");
    expect(missing.status).not.toBe(0); expect(missing.stdout).toContain('"status": "missing"');
    fs.writeFileSync(path.join(root, "a.ttf"), "font-x");
    const mismatch = run("--font-lock-verify=lock.json", "--font-file=a.ttf", "--font-file=b.otf");
    expect(mismatch.status).not.toBe(0); expect(mismatch.stdout).toContain('"status": "mismatch"');
    expect(run("--font-lock-verify=lock.json", "--font-file=a.ttf", "--font-file=a.ttf").status).not.toBe(0);
    expect(run("--font-lock-verify=lock.json", "--font-file=missing.ttf").status).not.toBe(0);
    fs.writeFileSync(path.join(root, "invalid.json"), '{"version":1,"files":[{"name":"../evil.ttf","sha256":"' + "a".repeat(64) + '"}]}');
    expect(run("--font-lock-verify=invalid.json").status).not.toBe(0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 120_000);


describe("environment lock create and verify", () => {
  const lock = (environment: Record<string, unknown>): EnvironmentLock => ({ version: 1, environment });
  it("snapshots the nine lockable fields with a stable fonts hash", () => {
    const snapshot = environmentSnapshot();
    for (const field of ["platform", "node", "ffmpeg", "browser", "browserPath", "resvg", "designTokens", "scenescript", "fontsHash"]) expect(String(snapshot[field] ?? "")).not.toBe("");
  });
  it("verifies a matching lock and reports per-field diffs on mismatch", () => {
    const snapshot = environmentSnapshot() as Record<string, string>;
    expect(verifyEnvironmentLock(lock(snapshot)).ok).toBe(true);
    const tampered = lock({ ...snapshot, node: "v0.0.0-test", ffmpeg: "deadbeef" });
    const result = verifyEnvironmentLock(tampered);
    expect(result.ok).toBe(false);
    expect(result.diffs.map(d => d.field)).toEqual(["node", "ffmpeg"]);
    expect(result.diffs[0]).toEqual({ field: "node", expected: "v0.0.0-test", actual: snapshot.node });
  });
  it("rejects malformed locks and unknown families only change the fonts fingerprint", () => {
    expect(() => parseEnvironmentLock("not json")).toThrow("环境锁文件不是有效 JSON");
    expect(() => parseEnvironmentLock('{"version":2}')).toThrow("环境锁文件格式无效");
    const withFamily = environmentSnapshot(["Arial"]);
    expect(verifyEnvironmentLock(lock(withFamily as Record<string, unknown>), ["Arial"]).ok).toBe(true);
  });
});
