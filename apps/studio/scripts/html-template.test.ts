import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { parseProject } from "@glintai/scenescript";
import { readTemplate, runHtmlTemplate } from "./html-template";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-html-template-")); roots.push(root);
  const file = path.join(root, "project.json"), out = path.join(root, "new.json");
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, id: "p", title: "P", aspect: "16:9", knowledgeSources: [], scenes: [{ id: "first", kind: "title", title: "旧镜头", narration: { text: "原旁白", durationMs: 1000 } }] }));
  return { root, file, out };
}
it("adds a parameterized template, reads it back, and updates a copy without changing other scenes", () => {
  const { root, file, out } = fixture(), log = vi.spyOn(console, "log").mockImplementation(() => {}), original = fs.readFileSync(file, "utf8");
  runHtmlTemplate([`--project=${file}`, "--scene=poster", "--append", "--headline=你好", "--accent=#ff0044", `--out=${out}`]);
  expect(fs.readFileSync(file, "utf8")).toBe(original);
  const created = parseProject(JSON.parse(fs.readFileSync(out, "utf8"))), scene = created.scenes[1]!;
  if (scene.kind !== "html") throw new Error("Expected html");
  expect(readTemplate(scene)).toMatchObject({ headline: "你好", accent: "#ff0044" });
  runHtmlTemplate([`--project=${out}`, "--scene=poster"]);
  expect(JSON.parse(String(log.mock.calls.at(-1)![0])).parameters.headline).toBe("你好");
  const updated = path.join(root, "updated.json");
  runHtmlTemplate([`--project=${out}`, "--scene=poster", "--headline=改标题", "--duration-ms=1200", `--out=${updated}`]);
  const edited = parseProject(JSON.parse(fs.readFileSync(updated, "utf8")));
  expect(edited.scenes[0]).toEqual(created.scenes[0]);
  const result = edited.scenes[1]!; if (result.kind !== "html") throw new Error("Expected html");
  expect(readTemplate(result)).toMatchObject({ headline: "改标题", durationMs: 1200 });
  expect(result.narration.text).toBe("你好"); // editing visual text does not silently rewrite narration
});
it("escapes hostile text and refuses invalid inputs, locked scenes and tampered HTML", () => {
  const { root, file, out } = fixture(); vi.spyOn(console, "log").mockImplementation(() => {});
  runHtmlTemplate([`--project=${file}`, "--scene=poster", "--append", '--headline=</div><script>bad()</script>', `--out=${out}`]);
  const project = parseProject(JSON.parse(fs.readFileSync(out, "utf8"))), scene = project.scenes[1]!;
  if (scene.kind !== "html") throw new Error("Expected html");
  expect(scene.html).toContain("&lt;script&gt;bad()&lt;/script&gt;"); expect(scene.html).not.toContain("<script>bad()");
  for (const arg of ["--accent=red", "--background=#gggggg", "--duration-ms=9999", "--headline="]) {
    expect(() => runHtmlTemplate([`--project=${out}`, "--scene=poster", arg, `--out=${path.join(root, "bad.json")}`])).toThrow();
    expect(fs.existsSync(path.join(root, "bad.json"))).toBe(false);
  }
  scene.html += "<p>hand edit</p>"; fs.writeFileSync(out, JSON.stringify(project));
  expect(() => runHtmlTemplate([`--project=${out}`, "--scene=poster", "--headline=changed", `--out=${path.join(root, "bad.json")}`])).toThrow(/手动修改/);
  scene.locked = true; fs.writeFileSync(out, JSON.stringify(project));
  expect(() => runHtmlTemplate([`--project=${out}`, "--scene=poster", "--headline=changed", `--out=${path.join(root, "bad.json")}`])).toThrow(/locked/);
});
it("runs through the actual CLI and preserves the original project", () => {
  const { file, out } = fixture(), cli = fileURLToPath(new URL("./glint.ts", import.meta.url)), tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
  const result = spawnSync(process.execPath, ["--import", tsx, cli, "html-template", `--project=${file}`, "--scene=poster", "--append", "--headline=产品发布", `--out=${out}`], { encoding: "utf8", timeout: 30000 });
  expect(result.status, result.stderr).toBe(0); expect(parseProject(JSON.parse(fs.readFileSync(out, "utf8"))).scenes).toHaveLength(2);
});

it("creates and edits a countdown template and refuses cross-template parameters", () => {
  const { root, file, out } = fixture(), log = vi.spyOn(console, "log").mockImplementation(() => {});
  runHtmlTemplate([`--project=${file}`, "--scene=count", "--append", "--template=countdown-v1", "--seconds=5", "--label=发布倒计时", `--out=${out}`]);
  const created = parseProject(JSON.parse(fs.readFileSync(out, "utf8"))), scene = created.scenes[1]!;
  if (scene.kind !== "html") throw new Error("Expected html");
  expect(readTemplate(scene)).toMatchObject({ template: "countdown-v1", seconds: 5, label: "发布倒计时" });
  expect(scene.narration).toEqual({ text: "发布倒计时", durationMs: 6000 });
  expect(scene.html).toContain("window.__glintTimeline");
  expect(scene.html).not.toContain("<script>bad()");
  const tuned = path.join(root, "tuned.json");
  runHtmlTemplate([`--project=${out}`, "--scene=count", "--seconds=3", "--accent=#22cc88", `--out=${tuned}`]);
  const edited = parseProject(JSON.parse(fs.readFileSync(tuned, "utf8"))).scenes[1]!;
  if (edited.kind !== "html") throw new Error("Expected html");
  expect(readTemplate(edited)).toMatchObject({ seconds: 3, accent: "#22cc88", label: "发布倒计时" });
  expect(edited.narration.durationMs).toBe(6000); // editing does not silently rewrite narration or scene length
  // 增大秒数会超出当前镜长,须先调整镜长。
  expect(() => runHtmlTemplate([`--project=${out}`, "--scene=count", "--seconds=6", `--out=${path.join(root, "long.json")}`])).toThrow(/镜长/);
  // 跨模板参数与越界拒绝;不产生输出文件。
  const rejects: string[][] = [
    ["--headline=x"], ["--duration-ms=800"], ["--seconds=2"], ["--seconds=61"], ["--template=poster-v1"],
  ];
  for (const args of rejects) expect(() => runHtmlTemplate([`--project=${out}`, "--scene=count", ...args, `--out=${path.join(root, "bad.json")}`])).toThrow();
  expect(fs.existsSync(path.join(root, "bad.json"))).toBe(false);
  runHtmlTemplate([`--project=${out}`, "--scene=count"]);
  expect(JSON.parse(String(log.mock.calls.at(-1)![0])).templates).toEqual(["poster-v1", "countdown-v1", "progress-v1"]);
});

it("creates and edits a progress template and refuses cross-template and out-of-range values", () => {
  const { root, file, out } = fixture(), log = vi.spyOn(console, "log").mockImplementation(() => {});
  runHtmlTemplate([`--project=${file}`, "--scene=bar", "--append", "--template=progress-v1", "--percent=72", "--label=年度目标", "--fill-ms=2400", `--out=${out}`]);
  const created = parseProject(JSON.parse(fs.readFileSync(out, "utf8"))), scene = created.scenes[1]!;
  if (scene.kind !== "html") throw new Error("Expected html");
  expect(readTemplate(scene)).toMatchObject({ template: "progress-v1", percent: 72, label: "年度目标", fillMs: 2400 });
  expect(scene.narration).toEqual({ text: "年度目标", durationMs: 3000 }); // max(3000, fill+400)
  expect(scene.html).toContain("scaleX(0)"); expect(scene.html).toContain("window.__glintTimeline");
  const tuned = path.join(root, "tuned.json");
  runHtmlTemplate([`--project=${out}`, "--scene=bar", "--percent=85", "--fill-ms=1200", "--accent=#22cc88", `--out=${tuned}`]);
  const edited = parseProject(JSON.parse(fs.readFileSync(tuned, "utf8"))).scenes[1]!;
  if (edited.kind !== "html") throw new Error("Expected html");
  expect(readTemplate(edited)).toMatchObject({ percent: 85, fillMs: 1200, accent: "#22cc88", label: "年度目标" });
  expect(edited.narration.durationMs).toBe(3000); // editing does not silently rewrite narration or scene length
  // 增大填充时长会超出当前镜长,须先调整镜长。
  expect(() => runHtmlTemplate([`--project=${out}`, "--scene=bar", "--fill-ms=4000", `--out=${path.join(root, "long.json")}`])).toThrow(/镜长/);
  // 跨模板参数、越界数值与宿主文本;一律拒绝且不产生输出文件。
  const rejects: string[][] = [
    ["--headline=x"], ["--seconds=5"], ["--duration-ms=800"], ["--template=poster-v1"],
    ["--percent=0"], ["--percent=101"], ["--percent=50.5"], ["--fill-ms=400"], ["--fill-ms=20000"], ["--accent=red"],
  ];
  for (const args of rejects) expect(() => runHtmlTemplate([`--project=${out}`, "--scene=bar", ...args, `--out=${path.join(root, "bad.json")}`])).toThrow();
  expect(fs.existsSync(path.join(root, "bad.json"))).toBe(false);
  // poster 场景不接受 progress 参数(反向同样拒绝)。
  expect(() => runHtmlTemplate([`--project=${out}`, "--scene=poster", "--percent=50", `--out=${path.join(root, "bad2.json")}`])).toThrow();
  expect(fs.existsSync(path.join(root, "bad2.json"))).toBe(false);
  // 宿主标签文本在进入 HTML 前转义。
  const hostile = path.join(root, "hostile.json");
  runHtmlTemplate([`--project=${out}`, "--scene=bar2", "--append", "--template=progress-v1", "--percent=40", '--label=</div><script>bad()</script>', `--out=${hostile}`]);
  const hostileScene = parseProject(JSON.parse(fs.readFileSync(hostile, "utf8"))).scenes[2]!;
  if (hostileScene.kind !== "html") throw new Error("Expected html");
  expect(hostileScene.html).toContain("&lt;script&gt;bad()&lt;/script&gt;"); expect(hostileScene.html).not.toContain("<script>bad()");
  runHtmlTemplate([`--project=${out}`, "--scene=bar"]);
  expect(JSON.parse(String(log.mock.calls.at(-1)![0])).templates).toEqual(["poster-v1", "countdown-v1", "progress-v1"]);
});

it("rejects unsupported, ambiguous and prototype-chain arguments without writing", () => {
  const { root, file, out } = fixture(); vi.spyOn(console, "log").mockImplementation(() => {});
  for (const args of [
    ["--template=toString"], ["--template=__proto__"], ["--seconds=4"],
    ["--headline=one", "--headline=two"], ["--headine=typo"], ["--headline"], ["--append"],
  ]) {
    expect(() => runHtmlTemplate([`--project=${file}`, "--scene=p", "--append", ...args, `--out=${out}`])).toThrow();
    expect(fs.existsSync(out)).toBe(false);
  }
  runHtmlTemplate([`--project=${file}`, "--scene=count", "--append", "--template=countdown-v1", `--out=${out}`]);
  const copy = path.join(root, "copy.json");
  runHtmlTemplate([`--project=${out}`, "--scene=count", "--label=新标签", `--out=${copy}`]);
  expect(fs.existsSync(copy)).toBe(true);
  expect(() => runHtmlTemplate([`--project=${out}`, "--scene=count", "--template=poster-v1"])).toThrow(/模板类型不符/);
});

it("rejects invalid or inherited marker types without replacing original HTML", () => {
  const { file, out } = fixture(); vi.spyOn(console, "log").mockImplementation(() => {});
  runHtmlTemplate([`--project=${file}`, "--scene=p", "--append", `--out=${out}`]);
  const project = parseProject(JSON.parse(fs.readFileSync(out, "utf8")));
  const scene = project.scenes[1]!; if (scene.kind !== "html") throw new Error("Expected html");
  for (const value of [null, {}, { template: "toString" }, { template: "__proto__" }]) {
    scene.html = `<!--glint-template:${encodeURIComponent(JSON.stringify(value))}-->`;
    expect(() => readTemplate(scene)).toThrow(/未知模板类型/);
  }
});
