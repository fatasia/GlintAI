import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import {
  fetchCiGolden,
  prepareCiGoldens,
  prepareCiRuntime,
  sourceConfig,
} from "./prepare-ci-fixtures.mjs";
const roots: string[] = [];
const temp = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-ci-test-"));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0))
    if (path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep))
      fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = temp(),
    source = temp();
  const cases = ["whiteboard", "blackboard", "dark", "lottie-single-shot"].map((id, index) => {
    const bytes = Buffer.from(`golden-${id}`),
      name = `${index}.mp4`;
    fs.writeFileSync(path.join(source, name), bytes);
    return {
      id,
      path: `evidence/SKILL-01/test/${name}`,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  });
  fs.mkdirSync(path.join(root, "apps/studio/scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "apps/studio/scripts/reference-eval-fixtures.json"),
    JSON.stringify({ cases }),
  );
  const urls = Object.fromEntries(
    cases.map((item) => [item.id, `https://fixtures.example/${item.id}.mp4`]),
  );
  return { root, source, cases, urls };
}
it("requires one explicit source and exact four locked IDs before network work", async () => {
  const { root, cases, urls } = fixture(),
    download = vi.fn();
  await expect(prepareCiGoldens(root, {}, download)).rejects.toThrow("exactly one");
  expect(download).not.toHaveBeenCalled();
  expect(() =>
    sourceConfig({ GLINT_CI_GOLDENS_DIR: "local", GLINT_CI_GOLDENS_URLS: "{}" }, cases),
  ).toThrow("exactly one");
  for (const value of [
    "bad-json",
    "[]",
    "null",
    JSON.stringify({ ...urls, extra: "https://example.com" }),
    JSON.stringify({ ...urls, dark: undefined }),
  ]) {
    expect(() => sourceConfig({ GLINT_CI_GOLDENS_URLS: value }, cases)).toThrow();
  }
});
it.each([
  "http://example.com/x",
  "https://user:secret@example.com/x",
  "https://example.com/x?token=secret",
  "https://example.com/x#secret",
])("rejects unsafe URL configuration without reflecting it: %s", (value) => {
  const { cases, urls } = fixture();
  expect(() =>
    sourceConfig({ GLINT_CI_GOLDENS_URLS: JSON.stringify({ ...urls, dark: value }) }, cases),
  ).toThrow("HTTPS without credentials, query or fragment");
});
it("uses Q26 for local validation and never overwrites an existing golden", async () => {
  const { root, source, cases } = fixture();
  await prepareCiGoldens(root, { GLINT_CI_GOLDENS_DIR: source });
  const output = path.join(root, cases[0]!.path);
  fs.writeFileSync(output, "other-owner");
  await expect(prepareCiGoldens(root, { GLINT_CI_GOLDENS_DIR: source })).rejects.toThrow(
    "Local golden preparation failed",
  );
  expect(fs.readFileSync(output, "utf8")).toBe("other-owner");
});
it("fails missing local inputs before publishing", async () => {
  const { root, source, cases } = fixture();
  fs.unlinkSync(path.join(source, "3.mp4"));
  await expect(prepareCiGoldens(root, { GLINT_CI_GOLDENS_DIR: source })).rejects.toThrow(
    "Local golden preparation failed",
  );
  expect(fs.existsSync(path.join(root, cases[0]!.path))).toBe(false);
});
it("downloads only explicit URLs then reuses Q26 and removes owned staging", async () => {
  const { root, source, cases, urls } = fixture();
  const before = new Set(fs.readdirSync(os.tmpdir()));
  const download = vi.fn(async (url: string, signal: AbortSignal) => {
    expect(signal.aborted).toBe(false);
    const index = cases.findIndex((item) => urls[item.id] === url);
    return { bytes: fs.readFileSync(path.join(source, `${index}.mp4`)) };
  });
  await prepareCiGoldens(root, { GLINT_CI_GOLDENS_URLS: JSON.stringify(urls) }, download);
  expect(download).toHaveBeenCalledTimes(4);
  for (const item of cases)
    expect(fs.readFileSync(path.join(root, item.path))).toEqual(
      fs.readFileSync(path.join(source, path.basename(item.path))),
    );
  expect(
    fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("glint-ci-goldens-") && !before.has(n)),
  ).toEqual([]);
});
it.each(["sha", "oversized", "network"])(
  "rejects %s failures, sanitizes errors and cleans staging",
  async (fault) => {
    const { root, cases, urls } = fixture();
    const before = new Set(fs.readdirSync(os.tmpdir()));
    const download = async () => {
      if (fault === "network")
        throw new Error(
          'GET "https://internal.host.example/secret/path/gold.mp4?token=secret" failed: ECONNRESET D:/private/dir',
        );
      return { bytes: Buffer.alloc(fault === "oversized" ? 1024 * 1024 + 1 : 4) };
    };
    const failure = await prepareCiGoldens(
      root,
      { GLINT_CI_GOLDENS_URLS: JSON.stringify(urls) },
      download,
    ).catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    for (const sentinel of [
      "secret",
      "internal.host.example",
      "ECONNRESET",
      "/secret/path",
      "D:/private/dir",
      "https://",
    ])
      expect(failure.message).not.toContain(sentinel);
    if (fault === "network") {
      expect(failure.message).toContain("download failed");
      expect(failure.message).toMatch(/for [a-z-]+: download failed/);
    } else {
      expect(failure.message).toBe("Golden bytes do not match the locked size or SHA256");
    }
    expect(fs.existsSync(path.join(root, cases[0]!.path))).toBe(false);
    expect(
      fs
        .readdirSync(os.tmpdir())
        .filter((n) => n.startsWith("glint-ci-goldens-") && !before.has(n)),
    ).toEqual([]);
  },
);
it("delegates all ten styles and Windows bridges to Q26 without a second generator", () => {
  const run = vi.fn();
  prepareCiRuntime("repo", { GLINT_CHROME_PATH: "explicit-browser" }, "linux", run);
  expect(run.mock.calls[0]![1]).toMatchObject({
    stages: ["styles"],
    styles: expect.any(Array),
    chrome: "explicit-browser",
  });
  expect(run.mock.calls[0]![1].styles).toHaveLength(10);
  prepareCiRuntime("repo", { GLINT_CHROME_PATH: "explicit-browser" }, "win32", run);
  expect(run.mock.calls[1]![1].stages).toEqual(["styles", "bridges"]);
  expect(() => prepareCiRuntime("repo", {}, "linux", run)).toThrow("Explicit");
});
function assertCiPreparationOrder(text: string) {
  const yaml = text.replace(/\r\n/g, "\n");
  const linux = yaml.split("  verify:")[1]!.split("  windows:")[0]!;
  const windows = yaml.split("  windows:")[1]!.split("  browser-core:")[0]!;
  for (const job of [linux, windows]) {
    for (const step of [
      "prepare-ci-fixtures.mjs goldens",
      "prepare-ci-fixtures.mjs runtime",
      "- run: pnpm test\n",
    ])
      expect(job.indexOf(step)).toBeGreaterThanOrEqual(0);
    expect(job.indexOf("prepare-ci-fixtures.mjs goldens")).toBeLessThan(
      job.indexOf("prepare-ci-fixtures.mjs runtime"),
    );
    expect(job.indexOf("prepare-ci-fixtures.mjs runtime")).toBeLessThan(
      job.indexOf("- run: pnpm test\n"),
    );
  }
  expect(linux).toContain("timeout-minutes: 20");
  // The windows job window grew to 45 with GLINT_CI_SLOW scaling (Q-06c); the
  // guard pins the live deadline so it cannot silently shrink again.
  expect(windows).toContain("timeout-minutes: 45");
  expect(windows.indexOf("cargo +stable fetch --locked")).toBeGreaterThanOrEqual(0);
  expect(windows.indexOf("cargo +stable fetch --locked")).toBeLessThan(
    windows.indexOf("prepare-ci-fixtures.mjs runtime"),
  );
}
it("CI retains job deadlines and prepares required inputs before full tests", () => {
  assertCiPreparationOrder(
    fs.readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
  );
});
it.each(["LF", "CRLF"])("preserves CI step and deadline checks for %s checkout bytes", (ending) => {
  const text = fs
    .readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")
    .replace(/\r\n/g, "\n");
  const checkout = ending === "CRLF" ? text.replace(/\n/g, "\r\n") : text;
  expect(checkout.includes("\r\n")).toBe(ending === "CRLF");
  assertCiPreparationOrder(checkout);
});
it("CLI blocks missing owner configuration with no input contents in logs", () => {
  const env = { ...process.env, GLINT_CI_GOLDENS_DIR: "", GLINT_CI_GOLDENS_URLS: "" };
  const run = spawnSync(
    process.execPath,
    [path.resolve("scripts/prepare-ci-fixtures.mjs"), "goldens"],
    { env, encoding: "utf8" },
  );
  expect(run.status).toBe(1);
  expect(run.stderr).toContain("CI fixture preparation blocked");
  expect(run.stderr).toContain("Configure exactly one owner-approved golden directory or URL map");
  expect(run.stdout).toBe("");
});

it("CLI keeps controlled reasons but never leaks raw non-module errors", () => {
  const run = spawnSync(
    process.execPath,
    [path.resolve("scripts/prepare-ci-fixtures.mjs"), "unexpected-stage"],
    { env: { ...process.env }, encoding: "utf8" },
  );
  expect(run.status).toBe(1);
  expect(run.stderr).toContain("CI fixture preparation blocked: Use goldens or runtime stage");
  expect(run.stderr).not.toMatch(/at |file:\/\/|node_modules/);
});

it("loads the existing HTTPS and public-address boundary without contacting loopback", async () => {
  await expect(fetchCiGolden("https://127.0.0.1/never", AbortSignal.timeout(1000))).rejects.toThrow(
    "Private, loopback or reserved source URL is not allowed",
  );
});
