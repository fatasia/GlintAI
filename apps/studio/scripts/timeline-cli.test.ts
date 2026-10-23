import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseProject, buildTimeline } from "@glintai/scenescript";
import { FileSessionStore } from "@glintai/session/node";
import { runTimeline, timelineCommand } from "./timeline-cli";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-timeline-cli-")); roots.push(root);
  const file = path.join(root, "project.json"), directory = path.join(root, "sessions");
  const project = parseProject({ schemaVersion: 1, id: "timeline-cli", title: "Timeline", aspect: "16:9", fps: 30, knowledgeSources: [], scenes: [
    { id: "one", kind: "title", title: "One", narration: { text: "one", durationMs: 1000 } },
    { id: "two", kind: "title", title: "Two", narration: { text: "two", durationMs: 1000 } },
  ] });
  fs.writeFileSync(file, JSON.stringify({ ...project, futureExtension: { keep: true } }));
  return { root, file, directory, args: [`--project=${file}`, `--store=${directory}`] };
}

describe("timeline shared transactions", () => {
  it("splits once across retries, preserves unknown fields, and supports shared undo/redo", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const f = fixture();
    const args = [...f.args, "--op=split", "--scene=one", "--at-ms=400", "--new-id=one-b", "--duplicate-text", "--base-revision=0", "--transaction=split-1"];
    runTimeline(args); runTimeline(args);
    const store = new FileSessionStore(f.directory, doc => { parseProject(doc); });
    expect(store.snapshot("timeline-cli").look.revision).toBe(1);
    expect(JSON.parse(fs.readFileSync(f.file, "utf8")).futureExtension).toEqual({ keep: true });
    expect(parseProject(JSON.parse(fs.readFileSync(f.file, "utf8"))).scenes.map(s => s.id)).toEqual(["one", "one-b", "two"]);
    expect(store.historyEdit("timeline-cli", "undo", "undo-1", 1, "user").receipt.stage).toBe("verified");
    expect(parseProject(JSON.parse(fs.readFileSync(f.file, "utf8"))).scenes.map(s => s.id)).toEqual(["one", "two"]);
    expect(store.historyEdit("timeline-cli", "redo", "redo-1", 2, "skill").receipt.stage).toBe("verified");
    expect(buildTimeline(parseProject(store.snapshot("timeline-cli").snapshot.document)).totalMs).toBe(2000);
  });
  it("refuses a stale revision and changed retry content without touching the file", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const f = fixture();
    const args = [...f.args, "--op=trim", "--edge=end", "--delta-ms=100", "--scene=one", "--base-revision=0", "--transaction=trim-1"];
    runTimeline(args);
    const saved = fs.readFileSync(f.file, "utf8");
    expect(() => runTimeline(args.map(a => a === "--transaction=trim-1" ? "--transaction=stale-2" : a))).toThrow(/Revision conflict/);
    expect(() => runTimeline(args.map(a => a === "--delta-ms=100" ? "--delta-ms=200" : a))).toThrow(/reused/);
    expect(fs.readFileSync(f.file, "utf8")).toBe(saved);
  });
  it("rejects a lock violation and an unsafe split without creating a revision", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const f = fixture();
    runTimeline([...f.args, "--op=lock", "--scene=two", "--locked=true", "--base-revision=0"]);
    expect(() => runTimeline([...f.args, "--op=ripple-delete", "--scene=one", "--base-revision=1"])).toThrow(/locked/);
    expect(() => runTimeline([...f.args, "--op=split", "--scene=one", "--at-ms=400", "--new-id=one-b", "--base-revision=1"])).toThrow(/duplicateText/);
    expect(new FileSessionStore(f.directory).snapshot("timeline-cli").look.revision).toBe(1);
  });
  it("requires explicit integer values and never invents a locked boolean", () => {
    expect(() => timelineCommand(["--op=trim", "--scene=one", "--edge=end", "--delta-ms=0.5"])).toThrow(/integer/);
    expect(() => timelineCommand(["--op=lock", "--scene=one", "--locked=maybe"])).toThrow(/true or false/);
    expect(() => timelineCommand(["--op=trim", "--scene=one", "--edge=middle", "--delta-ms=5"])).toThrow(/edge/);
  });
  it("reaches the real CLI from an unrelated working directory", () => {
    const f = fixture();
    const require = createRequire(import.meta.url);
    const entry = fileURLToPath(new URL("./glint.ts", import.meta.url));
    const child = spawnSync(process.execPath, ["--import", pathToFileURL(require.resolve("tsx")).href, entry, "timeline", ...f.args,
      "--op=trim", "--scene=one", "--edge=end", "--delta-ms=200", "--base-revision=0", "--transaction=child-1"], {
      cwd: f.root, env: { ...process.env, INIT_CWD: f.root }, encoding: "utf8", timeout: 30_000,
    });
    expect(child.status, child.stderr).toBe(0);
    expect(parseProject(JSON.parse(fs.readFileSync(f.file, "utf8"))).scenes[0]!.narration.durationMs).toBe(800);
    expect(child.stdout).toContain('"stage": "verified"');
  }, 40_000);
});
