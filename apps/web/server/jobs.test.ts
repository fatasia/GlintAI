import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJobRunner, validateMakeInput } from "./jobs.mjs";
import { TEMPLATES } from "@glintai/composer";
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function setup(overrides = {}) {
  const studioDir = fs.mkdtempSync(path.join(os.tmpdir(), "glint-jobs-test-"));
  const children: any[] = [], captures: any[] = [];
  const killTree = vi.fn((child) => child.emit("close", null));
  const options = { studioDir, templates: TEMPLATES, execArgs: ["fixture.mjs"], killTree,
    spawnFn: (_exe, args, config) => {
      captures.push({ args, config });
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
      children.push(child); return child;
    }, env: {}, maxConcurrency: 1, ...overrides };
  const runner = createJobRunner(options);
  cleanups.push(() => { runner.dispose(); fs.rmSync(studioDir, { recursive: true, force: true }); });
  const success = (index = 0) => {
    const out = captures[index].args.find((arg) => arg.startsWith("--out=")).slice(6);
    fs.writeFileSync(out, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(20)]));
    children[index].emit("close", 0);
  };
  return { runner, options, children, captures, killTree, success };
}
describe("make input", () => {
  it("rejects filesystem paths and URLs as background music", () => {
    for (const music of ["../../private.wav", "https://test/audio.mp3", "C:/private.wav"]) expect(validateMakeInput({ idea: "test", music }).error).toBeTruthy();
    expect(validateMakeInput({ idea: "test", music: "task-123.mp3" }).music).toBe("task-123.mp3");
    expect(validateMakeInput({ idea: "test", music: "auto" }).music).toBe("auto");
  });
  it("validates source, limits, template, theme and aspect", () => {
    for (const input of [{}, { idea: "a", source: "b" }, { idea: "a".repeat(2001) }, { idea: "a", theme: "unknown" }, { idea: "a", aspect: "4:3" }, { idea: "a", template: "unknown" }]) expect(validateMakeInput(input, TEMPLATES).error).toBeTruthy();
    expect(validateMakeInput({ source: "# Source\nUseful text", template: "recap", theme: "mint-clean" }, TEMPLATES).error).toBeUndefined();
  });
});
describe("job lifecycle", () => {
  it("passes prose as one argv with no shell and never exposes raw output", () => {
    const { runner, captures, children, success } = setup();
    const { jobId } = runner.submit({ idea: "hello; dangerous command", theme: "mint-clean" });
    expect(captures[0].args).toContain("--idea=hello; dangerous command");
    expect(captures[0].config.shell).toBe(false);
    children[0].stdout.write("SECRET api-key provider-body\n[glint] 4/4 rendering...\n");
    expect(JSON.stringify(runner.get(jobId))).not.toContain("SECRET");
    expect(runner.get(jobId).stage).toBe("render");
    success(); expect(runner.get(jobId).status).toBe("done");
  });
  it("requires an actual artifact and settles error/close exactly once", () => {
    const { runner, children } = setup();
    const first = runner.submit({ idea: "one" });
    const second = runner.submit({ idea: "two" });
    children[0].emit("error", new Error("SECRET")); children[0].emit("close", 0);
    expect(runner.get(first.jobId).status).toBe("failed");
    expect(runner.get(second.jobId).status).toBe("running");
    expect(runner._tests.pending).toBe(1);
    children[1].emit("close", 0);
    expect(runner.get(second.jobId).status).toBe("failed");
  });
  it("queues, cancels whole process trees and deduplicates requests", () => {
    const { runner, children, killTree } = setup();
    const first = runner.submit({ idea: "one", requestId: "request-1234" });
    expect(runner.findRequest("request-1234").id).toBe(first.jobId);
    expect(runner.findRequest("request-missing")).toBeNull();
    expect(runner.submit({ idea: "one", requestId: "request-1234" })).toEqual(first);
    const queued = runner.submit({ idea: "two" });
    expect(runner.get(queued.jobId).status).toBe("queued");
    expect(runner.cancel(queued.jobId)).toBe(true);
    expect(runner.get(queued.jobId).status).toBe("cancelled");
    runner.cancel(first.jobId);
    expect(killTree).toHaveBeenCalledWith(children[0]);
    expect(runner.get(first.jobId).status).toBe("cancelled");
    expect(runner._tests.pending).toBe(0);
  });
  it("recovers completed jobs and marks interrupted work failed on restart", () => {
    const { runner, options, success } = setup();
    const first = runner.submit({ source: "# Source\nSource sentence." }); success();
    const interrupted = runner.submit({ idea: "two" });
    const recovered = createJobRunner(options);
    cleanups.push(() => recovered.dispose());
    expect(recovered.get(first.jobId).status).toBe("done");
    expect(recovered.get(interrupted.jobId).stage).toBe("interrupted");
  });
  it("resolves the installed tsx loader rather than assuming its pnpm layout", () => {
    const { runner } = setup();
    expect(runner.submit({ idea: "one" }).jobId).toBeTruthy();
  });
});
it("renders the edited project without composing again and validates profiles", () => {
  const { runner, captures, success } = setup();
  const project = { schemaVersion: 1, id: "edited", title: "Edited", aspect: "16:9", knowledgeSources: [], scenes: [{ id: "one", kind: "title", title: "Edit", narration: { text: "Changed text" } }] };
  const submitted = runner.submit({ project, template: "explainer", theme: "glint-dark", tts: "mock", encoding: "balanced", requestId: "edit-request-123" });
  expect(submitted.jobId).toBeTruthy();
  expect(captures[0].args).toContain("render");
  expect(captures[0].args).not.toContain("make");
  expect(captures[0].args).toContain("--encoding=balanced");
  expect(captures[0].args).not.toContain("--fast");
  expect(captures[0].args.some((arg: string) => arg.startsWith("--theme=") || arg.startsWith("--template="))).toBe(false);
  expect(runner.submit({ project, tts: "mock", encoding: "quality", requestId: "edit-request-123" }).error).toBeTruthy();
  success();
  expect(runner.get(submitted.jobId).status).toBe("done");
  expect(runner.submit({ project, encoding: "nope" }).error).toBeTruthy();
  expect(validateMakeInput({ project, source: "x" }).error).toBeTruthy();
  expect(validateMakeInput({ project: { ...project, scenes: [{ id: "a", kind: "html", html: "x", narration: { text: "x" } }] } }).error).toBeTruthy();
});
const libraryProject = (kind: "image" | "video", src: string) => ({ schemaVersion: 1, id: "library", title: "Library", aspect: "16:9", knowledgeSources: [], scenes: [{ id: kind, kind, src, narration: { text: "Library explanation" } }] });
it("accepts only exact kind-specific library image and video sources", () => {
  for (const kind of ["image", "video"] as const) {
    const extension = kind === "image" ? "png" : "mp4";
    for (const name of ["a", "A_0-", "a".repeat(100)]) expect(validateMakeInput({ project: libraryProject(kind, `assets/${name}.${extension}`) }).error).toBeUndefined();
    for (const src of [`assets/${"a".repeat(101)}.${extension}`, `assets/.${extension}`, `../assets/a.${extension}`, `assets/../a.${extension}`, `assets/sub/a.${extension}`, `assets\\a.${extension}`, `/assets/a.${extension}`, `https://host/a.${extension}`, `assets/%2e%2e/a.${extension}`, `assets/a.${extension}?x`, `assets/a.${extension}#x`, `assets/a.${extension}\n`, "assets/a.mp3", "assets/a.html", kind === "image" ? "assets/a.mp4" : "assets/a.png"]) {
      expect(validateMakeInput({ project: libraryProject(kind, src) }).error, src).toBeTruthy();
    }
    const project = libraryProject(kind, `assets/a.${extension}`);
    expect(validateMakeInput({ project: { ...project, music: { src: "assets/music.wav" } } }).error).toBeTruthy();
    expect(validateMakeInput({ project: { ...project, scenes: [{ ...project.scenes[0], narration: { text: "x", audioRef: "assets/audio.wav" } }] } }).error).toBeTruthy();
  }
  for (const extension of ["png", "jpg", "webp"]) expect(validateMakeInput({ project: libraryProject("image", `assets/a.${extension}`) }).error).toBeUndefined();
});
it("stages real image and video bytes beside the unchanged relative project sources", () => {
  const files = new Map<string, string>();
  const { runner, options, captures } = setup({ musicAsset: (name: string) => files.get(name) ?? null });
  const image = Buffer.from([137, 80, 78, 71, 0, 255]), video = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(20, 42)]);
  for (const [name, bytes] of [["library.png", image], ["clip.mp4", video]] as const) {
    const file = path.join(options.studioDir, name); fs.writeFileSync(file, bytes); files.set(name, file);
  }
  const project = { ...libraryProject("image", "assets/library.png"), scenes: [...libraryProject("image", "assets/library.png").scenes, ...libraryProject("video", "assets/clip.mp4").scenes] };
  expect(runner.submit({ project }).jobId).toBeTruthy();
  const args = captures[0].args;
  expect(args).toContain("render"); expect(args).not.toContain("make"); expect(captures[0].config.shell).toBe(false);
  const file = args.find((arg: string) => arg.startsWith("--project=")).slice(10);
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  expect(saved.scenes.map(scene => scene.src)).toEqual(["assets/library.png", "assets/clip.mp4"]);
  expect(fs.readFileSync(path.join(path.dirname(file), saved.scenes[0].src))).toEqual(image);
  expect(fs.readFileSync(path.join(path.dirname(file), saved.scenes[1].src))).toEqual(video);
  for (const kind of ["image", "video"] as const) expect(runner.submit({ project: libraryProject(kind, `assets/missing.${kind === "image" ? "png" : "mp4"}`) }).error).toMatch(/not found/);
  expect(captures).toHaveLength(1);
});
it("rechecks queued video availability before spawning a render", () => {
  let available = true;
  const { runner, options, captures, success } = setup({ musicAsset: () => available ? path.join(options.studioDir, "clip.mp4") : null });
  fs.writeFileSync(path.join(options.studioDir, "clip.mp4"), "video bytes");
  runner.submit({ idea: "block the queue" });
  const queued = runner.submit({ project: libraryProject("video", "assets/clip.mp4") });
  expect(runner.get(queued.jobId).status).toBe("queued");
  available = false; success();
  expect(runner.get(queued.jobId).status).toBe("failed"); expect(captures).toHaveLength(1);
});
