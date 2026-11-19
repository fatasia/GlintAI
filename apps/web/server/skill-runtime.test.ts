import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parseProject } from "@glintai/scenescript";
import { createSkillRuntime, skillMain } from "./skill-runtime";
import { createWebServer } from "./index.mjs";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

/** Fixtures are plain .mjs files executed by the runtime as real child processes. */
function writeSkill(root: string, id: string, manifest: object | null, runner: string) {
  const dir = path.join(root, "skills", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${id}\ndescription: fixture\n---\n`);
  if (manifest) fs.writeFileSync(path.join(dir, "glint.skill.json"), JSON.stringify(manifest));
  if (runner) fs.writeFileSync(path.join(dir, "run.mjs"), runner);
}
const runtimeFor = (root: string, env = process.env) => createSkillRuntime({ repoRoot: root, dataDir: path.join(root, "data"), env, parseProject });

it("runs a declared skill in isolation: patch validated, assets kept, receipt persisted", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-skill-")); roots.push(root);
  fs.writeFileSync(path.join(root, "skills-lock.json"), JSON.stringify({ skills: { maker: { computedHash: "a".repeat(64) } } }));
  writeSkill(root, "maker", { entry: "run.mjs", outputs: ["projectPatch", "assets"], timeoutMs: 30000 }, `
    import fs from "node:fs";
    import path from "node:path";
    const chunks = []; for await (const c of process.stdin) chunks.push(c);
    const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    fs.mkdirSync(path.join(request.workspace, "out"));
    fs.writeFileSync(path.join(request.workspace, "out", "cover.png"), Buffer.from([0x89, 0x50]));
    process.stdout.write(JSON.stringify({ notes: "made", projectPatch: { schemaVersion: 1, id: "patched", title: "P", aspect: "16:9", knowledgeSources: [], scenes: [{ id: "one", kind: "title", title: "T", narration: { text: "x" } }] }, assets: ["cover.png"] }) + "\\n");
  `);
  const runtime = runtimeFor(root);
  expect(runtime.inspect("maker")).toMatchObject({ runnable: true, pinned: true, hash: "a".repeat(64) });
  const receipt = await runtime.run({ skill: "maker", grants: { project: true, assets: true } });
  expect(receipt.ok).toBe(true);
  expect(receipt.hash).toBe("a".repeat(64));
  expect(() => parseProject(receipt.projectPatch)).not.toThrow();
  expect(receipt.assets).toHaveLength(1);
  expect(fs.existsSync(path.join(root, "data", "skill-assets", receipt.assets[0]!))).toBe(true);
  expect(runtime.receipts()).toHaveLength(1);
});

it("denies credentials unless network is granted", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-skill-")); roots.push(root);
  fs.writeFileSync(path.join(root, "skills-lock.json"), JSON.stringify({ skills: { peek: { computedHash: "b".repeat(64) } } }));
  writeSkill(root, "peek", { entry: "run.mjs", outputs: [], timeoutMs: 30000 }, `
    const chunks = []; for await (const c of process.stdin) chunks.push(c);
    JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const keys = Object.keys(process.env).filter(key => key.startsWith("GLINT_"));
    process.stdout.write(JSON.stringify({ notes: keys.join(",") }) + "\\n");
  `);
  const env = { ...process.env, GLINT_MEDIA_API_KEY: "secret", PATH: process.env.PATH };
  const denied = await runtimeFor(root, env).run({ skill: "peek", grants: {} });
  expect(denied.ok).toBe(true);
  expect(denied.notes).toBe("");
  const granted = await runtimeFor(root, env).run({ skill: "peek", grants: { network: true } });
  expect(granted.notes).toContain("GLINT_MEDIA_API_KEY");
});

it("refuses unpinned hash drift, missing contracts and escaping entries before spawning", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-skill-")); roots.push(root);
  fs.writeFileSync(path.join(root, "skills-lock.json"), JSON.stringify({ skills: { pinned: { computedHash: "c".repeat(64) } } }));
  writeSkill(root, "pinned", null, "");
  writeSkill(root, "unpinned", { entry: "run.mjs", outputs: [] }, "// unpinned fixture: lock check must refuse before this ever runs\n");
  writeSkill(root, "escapee", { entry: "../pinned/run.mjs", outputs: [] }, "");
  const runtime = runtimeFor(root);
  const drift = await runtime.run({ skill: "unpinned", grants: {} });
  expect(drift.refused).toMatch(/not pinned/);
  const noContract = await runtime.run({ skill: "pinned", grants: {} });
  expect(noContract.refused).toMatch(/no run contract/);
  expect(runtime.inspect("escapee").runnable).toBe(false);
  expect(runtime.inspect("escapee").error).toMatch(/inside the skill directory/);
  expect(runtime.receipts().filter(receipt => receipt.refused)).toHaveLength(2);
});

it("kills overrun runs and records the signal", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-skill-")); roots.push(root);
  fs.writeFileSync(path.join(root, "skills-lock.json"), JSON.stringify({ skills: { slow: { computedHash: "d".repeat(64) } } }));
  writeSkill(root, "slow", { entry: "run.mjs", outputs: [], timeoutMs: 1000 }, `
    const chunks = []; for await (const c of process.stdin) chunks.push(c);
    await new Promise(resolve => setTimeout(resolve, 30000));
  `);
  const receipt = await runtimeFor(root).run({ skill: "slow", grants: {} });
  expect(receipt.ok).toBe(false);
  expect(receipt.exit.signal ?? receipt.exit.code).toBeTruthy();
  expect(receipt.durationMs).toBeLessThan(20000);
}, 30000);

it("drops an unparseable projectPatch instead of propagating it", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-skill-")); roots.push(root);
  fs.writeFileSync(path.join(root, "skills-lock.json"), JSON.stringify({ skills: { broken: { computedHash: "e".repeat(64) } } }));
  writeSkill(root, "broken", { entry: "run.mjs", outputs: ["projectPatch"], timeoutMs: 30000 }, `
    const chunks = []; for await (const c of process.stdin) chunks.push(c);
    JSON.parse(Buffer.concat(chunks).toString("utf8"));
    process.stdout.write(JSON.stringify({ projectPatch: { id: "nope" } }) + "\\n");
  `);
  const receipt = await runtimeFor(root).run({ skill: "broken", grants: { project: true } });
  expect(receipt.projectPatch).toBeUndefined();
  expect(receipt.ok).toBe(true);
});

it("skillMain prints exactly one JSON result line", async () => {
  const logs: string[] = [];
  const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk => { logs.push(String(chunk)); return true; }) as never);
  const stdin = Object.getOwnPropertyDescriptor(process, "stdin")!;
  Object.defineProperty(process, "stdin", { configurable: true, value: { async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ skill: "x" })); } } });
  try { await skillMain(async request => ({ notes: `got ${request.skill}` })); }
  finally {
    Object.defineProperty(process, "stdin", stdin);
    write.mockRestore();
  }
  expect(logs).toHaveLength(1);
  expect(JSON.parse(logs[0]!)).toEqual({ notes: "got x" });
});

it("serves POST /api/skills/run and GET /api/skills/runs end to end", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-skill-")); roots.push(root);
  fs.writeFileSync(path.join(root, "skills-lock.json"), JSON.stringify({ skills: { webby: { computedHash: "f".repeat(64) } } }));
  writeSkill(root, "webby", { entry: "run.mjs", outputs: [], timeoutMs: 30000 }, `
    const chunks = []; for await (const c of process.stdin) chunks.push(c);
    const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    process.stdout.write(JSON.stringify({ notes: "hello " + request.inputs.who }) + "\\n");
  `);
  const runtime = createSkillRuntime({ repoRoot: root, dataDir: path.join(root, "data"), env: process.env, parseProject });
  const server = createWebServer({ skillRuntime: runtime });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const run = await (await fetch(`${origin}/api/skills/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ skill: "webby", inputs: { who: "web" }, grants: {} }) })).json();
    expect(run.ok).toBe(true);
    expect(run.notes).toBe("hello web");
    const runs = await (await fetch(`${origin}/api/skills/runs`)).json();
    expect(runs.runs).toHaveLength(1);
    expect(runs.runs[0].skill).toBe("webby");
    const missing = await (await fetch(`${origin}/api/skills/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ skill: "ghost", grants: {} }) }));
    expect(missing.status).toBe(409);
  } finally { server.closeAllConnections?.(); server.close(); }
});
