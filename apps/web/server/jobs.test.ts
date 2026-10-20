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
function setup() {
  const studioDir = fs.mkdtempSync(path.join(os.tmpdir(), "glint-jobs-test-"));
  const children: any[] = [], captures: any[] = [];
  const killTree = vi.fn((child) => child.emit("close", null));
  const options = { studioDir, templates: TEMPLATES, execArgs: ["fixture.mjs"], killTree,
    spawnFn: (_exe, args, config) => {
      captures.push({ args, config });
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
      children.push(child); return child;
    }, env: {}, maxConcurrency: 1 };
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
it("stages only selected library images and rejects unknown assets", () => {
  const { options, captures } = setup();
  const image = path.join(options.studioDir, "fixture.png"); fs.writeFileSync(image, "image fixture");
  const runner = createJobRunner({ ...options, musicAsset: name => name === "library.png" ? image : null });
  cleanups.push(() => runner.dispose());
  const project = { schemaVersion: 1, id: "images", title: "Images", aspect: "16:9", knowledgeSources: [], scenes: [{ id: "image", kind: "image", src: "assets/library.png", narration: { text: "Image explanation" } }] };
  expect(runner.submit({ project }).jobId).toBeTruthy();
  const file = captures[0].args.find((arg: string) => arg.startsWith("--project=")).slice(10);
  expect(fs.readFileSync(path.join(path.dirname(file), "assets", "library.png"), "utf8")).toBe("image fixture");
  expect(runner.submit({ project: { ...project, scenes: [{ ...project.scenes[0], src: "assets/missing.png" }] } }).error).toMatch(/not found/);
});
