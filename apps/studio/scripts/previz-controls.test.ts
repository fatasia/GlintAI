import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { planControlFrame, exportControlFrame } from "./previz-controls";
import { runPrevizControls } from "./previz-controls-cli";

import { fixture } from "./previz-controls-fixture";

it("uses shot-relative camera time, stable output and original document", () => {
  const doc = fixture(),
    original = JSON.stringify(doc);
  const first = planControlFrame(doc, { shot: "shot", frame: 0 });
  const later = planControlFrame(doc, { shot: "shot", frame: 24 });
  expect(first.metadata.camera.position).toEqual([4, 3, 6]);
  expect(later.metadata.camera.position).toEqual([-4, 3, 6]);
  expect(later.metadata.absoluteTimeMs).toBe(3000);
  expect(planControlFrame(doc, { shot: "shot", frame: 0 })).toEqual(first);
  expect(JSON.stringify(doc)).toBe(original);
  expect(first.project.scenes.map((s) => s.id)).toEqual(["rgb", "depth", "normal"]);
});

it("rejects malformed, unsupported and unbounded inputs", () => {
  const options = { shot: "shot", frame: 0 };
  expect(() => planControlFrame({}, options)).toThrow("invalid-previz");
  expect(() =>
    planControlFrame(
      { ...fixture(), actors: [{ id: "a", name: "A", heightM: 1.7, position: [0, 0, 0] }] },
      options,
    ),
  ).toThrow("unsupported-content");
  const doc = fixture();
  doc.props[0]!.shape = "model";
  expect(() => planControlFrame(doc, options)).toThrow("unsupported-content");
  for (const patch of [
    { frame: -1 },
    { frame: 48 },
    { width: 2049 },
    { near: 0 },
    { near: 2, far: 1 },
    { far: Infinity },
  ])
    expect(() => planControlFrame(fixture(), { ...options, ...patch })).toThrow();
});

it("keeps existing output and cancels before claiming output", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "previz-test-"));
  try {
    await fs.writeFile(path.join(root, "sentinel"), "original");
    await expect(exportControlFrame(fixture(), { shot: "shot", frame: 0 }, root)).rejects.toThrow();
    expect(await fs.readFile(path.join(root, "sentinel"), "utf8")).toBe("original");
    const output = path.join(root, "cancelled");
    await expect(
      exportControlFrame(fixture(), { shot: "shot", frame: 0 }, output, AbortSignal.abort()),
    ).rejects.toThrow();
    await expect(fs.stat(output)).rejects.toThrow();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it("CLI reports invalid arguments and malformed JSON without leaking paths", async () => {
  const logs: string[] = [];
  expect(await runPrevizControls(["--wrong=1"], (line) => logs.push(line))).toBe(1);
  expect(JSON.parse(logs[0]!).error).toBe("invalid-argument");
  expect(await runPrevizControls(["--document=does-not-exist"], (line) => logs.push(line))).toBe(1);
  expect(JSON.parse(logs[1]!).error).toBe("ENOENT");
});

it("keeps primitive geometry bounded and encodes document strings safely", () => {
  const doc = fixture();
  doc.title = "</script><script>alert(1)</script>";
  doc.props.push(
    { ...doc.props[0]!, id: "sphere", shape: "sphere" },
    { ...doc.props[0]!, id: "cylinder", shape: "cylinder" },
  );
  const plan = planControlFrame(doc, { shot: "shot", frame: 1, width: 160 });
  expect(plan.metadata.camera.tMs).toBe(42);
  expect(plan.project.scenes[0]!.kind).toBe("html");
  const scene = plan.project.scenes[0]!;
  if (scene.kind !== "html") throw new Error("expected HTML");
  expect(scene.html).not.toContain("alert(1)");
  expect(scene.html).toContain('"shape":"sphere"');
  expect(scene.html).toContain('"shape":"cylinder"');
  expect(
    planControlFrame({ ...doc, aspect: "9:16" }, { shot: "shot", frame: 0, width: 90 }).height,
  ).toBe(160);
  expect(
    planControlFrame({ ...doc, aspect: "1:1" }, { shot: "shot", frame: 0, width: 90 }).height,
  ).toBe(90);
});
