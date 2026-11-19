import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { FileSessionStore } from "@glintai/session/node";
import { runSession } from "./session-cli";

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const workspace = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glint-session-cli-")); directories.push(dir); return dir; };
const project = () => ({ schemaVersion: 1, id: "cli-demo", title: "旧标题", aspect: "16:9", fps: 30, knowledgeSources: [], scenes: [{ id: "s1", kind: "title", title: "要点", subtitle: "副标", narration: { text: "讲两句", durationMs: 3000 } }] });

it("drives open/set/verify/undo through the same durable store the server uses", () => {
  const dir = workspace(), file = path.join(dir, "project.json"), store = path.join(dir, "store");
  fs.writeFileSync(file, JSON.stringify(project()));
  runSession(["inspect", `--project=${file}`, `--store=${store}`]);
  runSession(["set", `--project=${file}`, `--store=${store}`, "--path=title", '--value="CLI 改的标题"', "--base-revision=0", "--transaction=tx-cli-1"]);
  const durable = new FileSessionStore(store);
  expect(durable.snapshot("cli-demo").snapshot.document.title).toBe("CLI 改的标题");
  process.exitCode = 0;
  runSession(["verify", `--project=${file}`, `--store=${store}`, "--transaction=tx-cli-1"]);
  expect(process.exitCode).toBe(0);
  runSession(["undo", `--project=${file}`, `--store=${store}`, "--base-revision=1", "--transaction=undo-1"]);
  expect(durable.snapshot("cli-demo").snapshot.document.title).toBe("旧标题");
  const receipt = durable.verify("cli-demo", "tx-cli-1");
  expect(["saved", "verified"]).toContain(receipt.stage);
});

it("refuses to import a file that drifted from the durable revision", () => {
  const dir = workspace(), file = path.join(dir, "project.json"), store = path.join(dir, "store");
  fs.writeFileSync(file, JSON.stringify(project()));
  runSession(["set", `--project=${file}`, `--store=${store}`, "--path=title", '--value="新"', "--base-revision=0"]);
  fs.writeFileSync(file, JSON.stringify({ ...project(), title: "外部手改" }));
  expect(() => runSession(["inspect", `--project=${file}`, `--store=${store}`])).toThrow(/changed outside/);
});

it("fails closed on a refused transaction so scripts can detect it", () => {
  const dir = workspace(), file = path.join(dir, "project.json"), store = path.join(dir, "store");
  fs.writeFileSync(file, JSON.stringify(project()));
  runSession(["set", `--project=${file}`, `--store=${store}`, "--path=title", '--value="一改"', "--base-revision=0"]);
  process.exitCode = 0;
  runSession(["set", `--project=${file}`, `--store=${store}`, "--path=title", '--value="陈旧改"', "--base-revision=0"]);
  expect(process.exitCode).toBe(2);
  const durable = new FileSessionStore(store);
  expect(durable.snapshot("cli-demo").snapshot.document.title).toBe("一改");
  process.exitCode = 0;
});
