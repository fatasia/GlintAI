import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { exportControlFrame } from "./previz-controls";
import { runPrevizControls } from "./previz-controls-cli";
import { fixture } from "./previz-controls-fixture";
import { animatedFixture } from "./previz-motion-fixture";

function pixels(file: string) {
  const result = spawnSync(
    "ffmpeg",
    ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
    { maxBuffer: 1024 * 1024, windowsHide: true },
  );
  expect(result.status, result.stderr.toString()).toBe(0);
  return result.stdout;
}
function hasWhiteAt(bytes: Buffer, width: number, height: number, x: number, y: number) {
  const px = Math.round(((x + 1) * width) / 2),
    py = Math.round(((1 - y) * height) / 2);
  for (let dy = -3; dy <= 3; dy++)
    for (let dx = -3; dx <= 3; dx++) {
      if (px + dx < 0 || px + dx >= width || py + dy < 0 || py + dy >= height) continue;
      const offset = ((py + dy) * width + px + dx) * 3;
      if (bytes[offset]! > 80 && bytes[offset + 1]! > 80 && bytes[offset + 2]! > 80) return true;
    }
  return false;
}
async function animatedCapture(root: string) {
  const doc = animatedFixture();
  const original = JSON.stringify(doc);
  const first = await exportControlFrame(
    doc,
    { shot: "shot", frame: 0, width: 320 },
    path.join(root, "motion-first"),
  );
  const later = await exportControlFrame(
    doc,
    { shot: "shot", frame: 6, width: 320 },
    path.join(root, "motion-later"),
  );
  const repeat = await exportControlFrame(
    doc,
    { shot: "shot", frame: 6, width: 320 },
    path.join(root, "motion-repeat"),
  );
  expect(first.artifacts).toHaveLength(4);
  expect(later.artifacts).toEqual(repeat.artifacts);
  for (const artifact of first.artifacts) {
    const a = pixels(path.join(root, "motion-first", artifact.file));
    const b = pixels(path.join(root, "motion-later", artifact.file));
    expect(a.length).toBe(320 * 180 * 3);
    expect(a).not.toEqual(b);
  }
  if (later.format !== "glint-previz-controls-v2") throw new Error("v2 skeleton metadata missing");
  const skeleton = pixels(path.join(root, "motion-later/skeleton.png"));
  const joints = later.skeleton.actors[0]!.joints.filter(
    (joint) =>
      joint.projection.inFront &&
      Math.abs(joint.projection.x) < 1 &&
      Math.abs(joint.projection.y) < 1,
  );
  expect(joints.length).toBeGreaterThan(10);
  for (const joint of joints)
    expect(hasWhiteAt(skeleton, 320, 180, joint.projection.x, joint.projection.y)).toBe(true);
  expect(JSON.stringify(doc)).toBe(original);
  console.log(JSON.stringify({ motionFirst: first, motionLater: later, motionRepeat: repeat }));
}

it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1")(
  "exports actual geometric RGB/depth/normal and a changed camera through CLI",
  async () => {
    const root = await fs.mkdtemp(
      path.join(process.env.GLINT_CONTROL_EVIDENCE_DIR || os.tmpdir(), "previz-render-"),
    );
    try {
      const first = await exportControlFrame(
        fixture(),
        { shot: "shot", frame: 0, width: 160, near: 1, far: 20 },
        path.join(root, "first"),
      );
      expect(first.artifacts).toHaveLength(3);
      const rgb = pixels(path.join(root, "first/rgb.png")),
        depth = pixels(path.join(root, "first/depth.png")),
        normal = pixels(path.join(root, "first/normal.png"));
      expect(rgb.length).toBe(160 * 90 * 3);
      expect([depth.length, normal.length]).toEqual([rgb.length, rgb.length]);
      expect(new Set(rgb).size).toBeGreaterThan(5);
      expect(depth).not.toEqual(rgb);
      expect(normal).not.toEqual(rgb);
      for (let i = 0; i < depth.length; i += 3) {
        expect(depth[i]).toBe(depth[i + 1]);
        expect(depth[i]).toBe(depth[i + 2]);
      }
      const center = (45 * 160 + 80) * 3;
      expect(depth[center]).toBeGreaterThan(100);
      expect(depth[center]).toBeLessThan(240);
      expect(normal[center + 2]).toBeGreaterThan(128);
      const repeat = await exportControlFrame(
        fixture(),
        { shot: "shot", frame: 0, width: 160, near: 1, far: 20 },
        path.join(root, "repeat"),
      );
      expect(repeat.artifacts).toEqual(first.artifacts);
      const source = path.join(root, "document.json");
      await fs.writeFile(source, JSON.stringify(fixture()));
      const logs: string[] = [];
      expect(
        await runPrevizControls(
          [
            `--document=${source}`,
            "--shot=shot",
            "--frame=24",
            "--width=160",
            "--near=1",
            "--far=20",
            `--out=${path.join(root, "later")}`,
          ],
          (line) => logs.push(line),
        ),
      ).toBe(0);
      expect(JSON.parse(logs[0]!).camera.position).toEqual([-4, 3, 6]);
      expect(pixels(path.join(root, "later/rgb.png"))).not.toEqual(rgb);
      expect(JSON.parse(await fs.readFile(source, "utf8"))).toEqual(fixture());
      await animatedCapture(root);
      console.log(JSON.stringify({ evidenceDirectory: root, first, later: JSON.parse(logs[0]!) }));
    } finally {
      if (!process.env.GLINT_CONTROL_EVIDENCE_DIR)
        await fs.rm(root, { recursive: true, force: true });
    }
  },
  120000,
);

it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1")(
  "cancels an export after claiming its directory and removes only its artifacts",
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "previz-cancel-"));
    const output = path.join(root, "output"),
      controller = new AbortController();
    await fs.writeFile(path.join(root, "sentinel"), "keep");
    const exporting = exportControlFrame(
      fixture(),
      { shot: "shot", frame: 0, width: 160 },
      output,
      controller.signal,
    );
    const timer = setInterval(() => {
      void fs
        .stat(output)
        .then(() => controller.abort())
        .catch(() => undefined);
    }, 5);
    try {
      await expect(exporting).rejects.toThrow();
      expect(controller.signal.aborted).toBe(true);
      await expect(fs.stat(output)).rejects.toThrow();
      expect(await fs.readFile(path.join(root, "sentinel"), "utf8")).toBe("keep");
    } finally {
      clearInterval(timer);
      await fs.rm(root, { recursive: true, force: true });
    }
  },
  120000,
);
