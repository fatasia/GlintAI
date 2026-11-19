import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { openSecureAssets } from "./secure-assets-bridge.mjs";
import { exportPortableChapters, importPortableChapters, preflightPortableChapters } from "./portable-chapter-migration";
import { parseProject } from "../../../packages/scenescript/src/parse";

it.runIf(process.platform === "win32")("uses one pinned native root for export, preflight and immutable import", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-bridge-isolated-"));
  const source = path.join(root, "assets"); fs.mkdirSync(source);
  const executable = path.resolve("apps/desktop/secure-assets/target/debug/glint-secure-assets.exe");
  const image = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=16x16", "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "pipe:1"], { windowsHide: true });
  expect(image.status, String(image.stderr)).toBe(0);
  fs.writeFileSync(path.join(source, "test.png"), image.stdout, { flag: "wx" });
  const bridge = await openSecureAssets(executable, source);
  try {
    const snapshot = { title: "isolated", updatedAt: 1, context: { mode: "source" as const, text: "", template: "explainer", theme: "whiteboard", evidence: "" }, project: parseProject({ schemaVersion: 1, id: "isolated", title: "isolated", aspect: "16:9", knowledgeSources: [], scenes: [{ id: "one", kind: "image", src: "assets/test.png", narration: { text: "test", durationMs: 1000 } }] }) };
    expect(() => fs.renameSync(source, path.join(root, "moved"))).toThrow();
    await expect(bridge.read("../test.png")).rejects.toThrow();
    await expect(bridge.read("missing.png")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(bridge.publish("test.png", Buffer.from("different"))).rejects.toMatchObject({ code: "EEXIST" });
    const bundle = await exportPortableChapters([snapshot], bridge.read);
    const preview = await preflightPortableChapters(bundle, bridge);
    expect(fs.readdirSync(source)).toEqual(["test.png"]);
    await expect(importPortableChapters(bundle, bridge, undefined, () => { throw new Error("expired"); })).rejects.toThrow("expired");
    expect(await importPortableChapters(bundle, bridge)).toEqual(preview);
    expect(await importPortableChapters(bundle, bridge)).toEqual(preview);
    expect(fs.readdirSync(source)).toHaveLength(2);
    expect(fs.readFileSync(path.join(source, "test.png"))).toEqual(image.stdout);
  } finally { await bridge.close(); }
  // Retain the exclusively created test directory for inspection; never delete user data.
}, 60000);
