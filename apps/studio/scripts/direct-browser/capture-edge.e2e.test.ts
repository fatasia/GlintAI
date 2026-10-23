import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { findSystemBrowser } from "./host";
import { openCaptureBrowser } from "./host";

/**
 * Proves the shipped Windows fallback works: capture with Microsoft Edge when
 * Chrome is absent. Opt-in (GLINT_EDGE_E2E=1) because it launches a real browser.
 */
const edgeCandidates = [
  `${process.env.PROGRAMFILES ?? "C:/Program Files"}/Microsoft/Edge/Application/msedge.exe`,
  `${process.env["PROGRAMFILES(X86)"] ?? "C:/Program Files (x86)"}/Microsoft/Edge/Application/msedge.exe`,
];
const edge = edgeCandidates.find(file => fs.existsSync(file));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-edge-capture-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

it.skipIf(process.env.GLINT_EDGE_E2E !== "1" || !edge)("captures a page with Edge and reports the Edge version", async () => {
  const previous = process.env.GLINT_CHROME_PATH;
  process.env.GLINT_CHROME_PATH = edge!;
  const { browser, page } = await openCaptureBrowser(320, 180);
  try {
    const version = await browser.version();
    expect(version).toMatch(/Edg\//);
    await page.setContent("<body style='margin:0;background:#123456'><div style='width:320px;height:180px;background:#ff0000'></div></body>");
    const shot = path.join(root, "edge.png");
    await page.screenshot({ path: shot as `${string}.png`, type: "png" });
    const bytes = fs.readFileSync(shot);
    expect(bytes.length).toBeGreaterThan(200);
    expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(bytes.readUInt32BE(16)).toBe(320);
    expect(bytes.readUInt32BE(20)).toBe(180);
    console.log(`[edge] capture ok with ${version}`);
  } finally {
    await browser.close();
    if (previous === undefined) delete process.env.GLINT_CHROME_PATH; else process.env.GLINT_CHROME_PATH = previous;
    expect(findSystemBrowser()).toBeTruthy();
  }
}, 60_000);
