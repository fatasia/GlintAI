import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { parseProject } from "../../../packages/scenescript/src/parse";
import { exportPortableChapters, importPortableChapters, preflightPortableChapters } from "./portable-chapter-migration";

it("preflights without publication and revalidates before idempotent publication", async () => {
  // Kept for inspection; never use or delete a real user library.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-chapter-preflight-"));
  const image = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=16x16", "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "pipe:1"], { windowsHide: true });
  expect(image.status, String(image.stderr)).toBe(0);
  const snapshot = { title: "isolated", updatedAt: 1, context: { mode: "source" as const, text: "", template: "explainer", theme: "whiteboard", evidence: "" }, project: parseProject({ schemaVersion: 1, id: "isolated", title: "isolated", aspect: "16:9", knowledgeSources: [], scenes: [{ id: "one", kind: "image", src: "assets/test.png", narration: { text: "test", durationMs: 1000 } }] }) };
  const bundle = await exportPortableChapters([snapshot], () => image.stdout);
  const preview = await preflightPortableChapters(bundle, root);
  expect(fs.readdirSync(root)).toEqual([]);
  const tampered = JSON.parse(bundle);
  tampered.chapters[0].assets[0].sha256 = "0".repeat(64);
  await expect(importPortableChapters(JSON.stringify(tampered), root)).rejects.toThrow();
  expect(fs.readdirSync(root)).toEqual([]);
  await expect(importPortableChapters(bundle, root, undefined, () => { throw new Error("预检凭证已过期"); })).rejects.toThrow(/过期/);
  expect(fs.readdirSync(root)).toEqual([]);
  const published = await importPortableChapters(bundle, root);
  expect(published).toEqual(preview);
  expect(await importPortableChapters(bundle, root)).toEqual(preview);
  expect(fs.readdirSync(root)).toHaveLength(1);
  const conflictRoot = fs.mkdtempSync(path.join(os.tmpdir(), "glint-chapter-conflict-"));
  const conflict = path.join(conflictRoot, `chapter-${createHash("sha256").update(image.stdout).digest("hex")}.png`);
  fs.writeFileSync(conflict, "existing user bytes", { flag: "wx" });
  await expect(preflightPortableChapters(bundle, conflictRoot)).rejects.toThrow(/冲突/);
  await expect(importPortableChapters(bundle, conflictRoot)).rejects.toThrow(/冲突/);
  expect(fs.readFileSync(conflict, "utf8")).toBe("existing user bytes");
}, 60_000);
