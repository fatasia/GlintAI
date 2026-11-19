import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createTaskCenterReader } from "./task-center-read.mjs";
const roots: string[] = [];
const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glint-task-center-"));
  roots.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of roots.splice(0))
    if (path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep))
      fs.rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const mediaDir = temp(),
    renderStateDir = temp();
  const put = (id: string, value: unknown, render = false) =>
    fs.writeFileSync(
      path.join(render ? renderStateDir : mediaDir, `${id}.json`),
      JSON.stringify(value),
    );
  return {
    mediaDir,
    renderStateDir,
    put,
    read: createTaskCenterReader({ mediaDir, renderStateDir }),
  };
}
it("projects media, Comfy and rendering records without private payloads or currency guesses", () => {
  const { put, read, mediaDir } = fixture();
  put("task1", {
    taskId: "task1",
    protocol: "skills",
    state: "success",
    cost: 0.25,
    createdAt: "2026-11-01T00:00:00Z",
    prompt: "private",
    apiKey: "credential",
    resultUrl: "https://private.invalid/result",
  });
  put("comfy-one", {
    taskId: "comfy-one",
    protocol: "comfyui",
    state: "running",
    terminal: { state: "success", outputs: [{ filename: "private" }] },
    workflow: { secret: true },
  });
  put(
    "idea-one",
    {
      id: "idea-one",
      status: "running",
      createdAt: 123,
      project: { secret: true },
      log: ["private path"],
    },
    true,
  );
  const before = fs.readFileSync(path.join(mediaDir, "task1.json"));
  const result = read();
  expect(result.tasks).toHaveLength(3);
  expect(result.tasks[0]).toMatchObject({
    family: "media",
    id: "task1",
    state: "success",
    cost: { amount: 0.25, unit: null },
  });
  expect(result.tasks.find((row) => row.family === "comfyui")).toMatchObject({
    state: "success",
    isFinal: true,
    cost: { amount: null, unit: null },
  });
  expect(JSON.stringify(result)).not.toMatch(/private|credential|workflow|resultUrl|project/);
  expect(fs.readFileSync(path.join(mediaDir, "task1.json"))).toEqual(before);
});
it("reports unreadable records and never exposes invalid identities, reservations or oversized files", () => {
  const { put, read, mediaDir } = fixture();
  put("bad", { taskId: "different", protocol: "skills" });
  put("request-reserved", { taskId: "reserved", signature: "private" });
  put("versions", [{ prompt: "private" }]);
  put("large", { taskId: "large", protocol: "skills", prompt: "x".repeat(256 * 1024) });
  fs.writeFileSync(path.join(mediaDir, "broken.json"), "{");
  const result = read();
  expect(result.tasks).toEqual([]);
  expect(result.unreadable).toBeGreaterThanOrEqual(2);
});
it("limits directory scanning and returned rows without implying complete history", () => {
  const { put, read, mediaDir } = fixture();
  for (let i = 0; i < 105; i++) put(`t${i}`, { taskId: `t${i}`, protocol: "skills" });
  expect(read()).toMatchObject({ truncated: true });
  expect(read().tasks).toHaveLength(100);
  for (let i = 0; i < 510; i++) fs.writeFileSync(path.join(mediaDir, `noise-${i}.txt`), "ignored");
  expect(read().truncated).toBe(true);
});
it("rejects a linked root and ignores linked records", () => {
  const { mediaDir, renderStateDir, read } = fixture();
  const outside = temp();
  fs.writeFileSync(path.join(outside, "source"), "secret");
  // A directory junction is not a task record on either platform.
  fs.symlinkSync(
    outside,
    path.join(mediaDir, "linked.json"),
    process.platform === "win32" ? "junction" : "dir",
  );
  expect(read()).toMatchObject({ tasks: [], unreadable: 1 });
  const rootLink = path.join(temp(), "root");
  fs.symlinkSync(outside, rootLink, process.platform === "win32" ? "junction" : "dir");
  expect(() => createTaskCenterReader({ mediaDir: rootLink, renderStateDir })()).toThrow(
    "directory changed",
  );
});
it("keeps local cancellation explicit and missing costs unknown", () => {
  const { put, read } = fixture();
  put("stopped", {
    taskId: "stopped",
    protocol: "skills",
    state: "running",
    cancelled: true,
    cost: -1,
  });
  put("waiting", { taskId: "waiting", protocol: "skills" });
  expect(read().tasks.find((row) => row.id === "stopped")).toMatchObject({
    state: "cancelled",
    isFinal: true,
    cost: { amount: null, unit: null },
  });
  expect(read().tasks.find((row) => row.id === "waiting")).toMatchObject({
    state: "unknown",
    isFinal: false,
  });
});
it("reads the original terminal receipt cost without inventing a unit", () => {
  const { put, read } = fixture();
  put("receipt", {
    taskId: "receipt",
    protocol: "skills",
    state: "success",
    isFinal: true,
    terminalReceipt: { task_id: "receipt", state: "success", is_final: true, cost: 0.125 },
  });
  expect(read().tasks[0]!.cost).toEqual({ amount: 0.125, unit: null });
});
