import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { parseProject } from "@glintai/scenescript";
import { createHash } from "node:crypto";
import { readImportedLottie, runLottieImport, validateLottie } from "./lottie-import";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-lottie-import-")); roots.push(root);
  const examples = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../../../examples/local-media/readiness.scenescript.json", import.meta.url)), "utf8"));
  const scene = examples.scenes.find((entry: { animation?: string }) => entry.animation === "lottie");
  const input = JSON.parse(scene.html.match(/window\.__glintLottie=([\s\S]*);<\/script>/)[1]);
  const source = path.join(root, "motion.json"), project = path.join(root, "project.json"), out = path.join(root, "new.json");
  fs.writeFileSync(source, JSON.stringify(input));
  fs.writeFileSync(project, JSON.stringify({ schemaVersion: 1, id: "p", title: "P", aspect: "16:9", knowledgeSources: [], scenes: [{ id: "first", kind: "title", title: "原镜头", narration: { text: "旁白", durationMs: 1000 } }] }));
  return { root, input, source, project, out };
}
it("inspects a local source before import without writing or executing it and recovers after rejection", () => {
  const { input, source, root } = fixture();
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const original = fs.readFileSync(source);
  runLottieImport([`--inspect-source=${source}`]);
  const report = JSON.parse(String(log.mock.calls.at(-1)![0]));
  expect(report).toMatchObject({ width: input.w, height: input.h, sourceFr: input.fr, layers: [{ index: 0, name: "Rectangle" }] });
  expect(report.note).toMatch(/不执行动画/);
  const cli = fileURLToPath(new URL("./glint.ts", import.meta.url)), tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
  const env = { ...process.env, HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, TEMP: root, TMP: root };
  const result = spawnSync(process.execPath, ["--import", tsx, cli, "lottie-import", `--inspect-source=${source}`], { cwd: root, env, encoding: "utf8", timeout: 30000 });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).layers).toEqual(report.layers);
  expect(fs.readFileSync(source)).toEqual(original);
  const files = fs.readdirSync(root);
  for (const args of [[], ["--inspect-source="], [`--inspect-source=${source}`, `--out=${path.join(root, "bad.json")}`], [`--inspect-source=${root}`], [`--inspect-source=${path.join(root, "missing.json")}`]]) {
    expect(() => runLottieImport(args)).toThrow();
  }
  fs.writeFileSync(source, JSON.stringify({ ...input, layers: [{ x: "alert(1)" }] }));
  expect(() => runLottieImport([`--inspect-source=${source}`])).toThrow(/表达式/);
  fs.writeFileSync(source, original);
  runLottieImport([`--inspect-source=${source}`]);
  expect(JSON.parse(String(log.mock.calls.at(-1)![0])).layers).toEqual(report.layers);
  expect(fs.readdirSync(root)).toEqual(files);
});

it("edits only a top-level static text document through the real CLI", () => {
  const { input, source, project, out, root } = fixture(); vi.spyOn(console, "log").mockImplementation(() => {});
  const textLayer = { ty: 5, nm: "Title", ind: 2, ks: structuredClone(input.layers[0].ks), t: { d: { k: [{ s: { t: "Before", f: "Arial", s: 48, fc: [1, 1, 1] }, t: 0 }] }, a: [] } };
  input.layers.push(textLayer);
  fs.writeFileSync(source, JSON.stringify(input));
  runLottieImport([`--project=${project}`, "--scene=animation", "--append", `--source=${source}`, `--out=${out}`]);
  const beforeSource = fs.readFileSync(source), beforeProject = fs.readFileSync(out);
  const cli = fileURLToPath(new URL("./glint.ts", import.meta.url)), tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
  const changed = path.join(root, "text.json"), text = '中文 😀 </script><script>bad()</script>\u2028';
  const env = { ...process.env, HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, TEMP: root, TMP: root };
  const result = spawnSync(process.execPath, ["--import", tsx, cli, "lottie-import", `--project=${out}`, "--scene=animation", "--layer-index=1", `--layer-text=${text}`, `--out=${changed}`], { cwd: root, env, encoding: "utf8", timeout: 30000 });
  expect(result.status, result.stderr).toBe(0);
  const scene = parseProject(JSON.parse(fs.readFileSync(changed, "utf8"))).scenes[1]!;
  if (scene.kind !== "html") throw new Error("Expected html");
  const expected = structuredClone(input); expected.layers[1].t.d.k[0].s.t = text;
  expect(readImportedLottie(scene).source).toEqual(expected);
  expect(scene.html).not.toContain("</script><script>bad()");
  expect(fs.readFileSync(source)).toEqual(beforeSource); expect(fs.readFileSync(out)).toEqual(beforeProject);
  runLottieImport([`--project=${changed}`, "--scene=animation"]);
  expect(JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)![0])).layers[1]).toMatchObject({ text, editableText: true });
  const empty = path.join(root, "empty.json");
  runLottieImport([`--project=${out}`, "--scene=animation", "--layer-index=1", "--layer-text=", `--out=${empty}`]);
  const emptyScene = parseProject(JSON.parse(fs.readFileSync(empty, "utf8"))).scenes[1]!;
  if (emptyScene.kind !== "html") throw new Error("Expected html");
  expect((readImportedLottie(emptyScene).source.layers[1] as any).t.d.k[0].s.t).toBe("");
  for (const flags of [["--layer-text=x"], ["--layer-index=0", "--layer-text=x"], ["--layer-index=1", `--layer-text=${"a".repeat(4097)}`], ["--layer-index=1", "--layer-text=\u0000"]]) {
    const bad = path.join(root, "bad-text.json");
    expect(() => runLottieImport([`--project=${out}`, "--scene=animation", ...flags, `--out=${bad}`])).toThrow();
    expect(fs.existsSync(bad)).toBe(false);
  }
  expect(() => runLottieImport([`--project=${out}`, "--scene=animation", "--layer-index=1", "--layer-text=x", `--out=${out}`])).toThrow();
  expect(fs.readFileSync(out)).toEqual(beforeProject);
  for (const [name, document] of [["animated", { k: [{ t: 0, s: { t: "A" } }, { t: 12, s: { t: "B" } }] }], ["animated-flag", { a: 1, k: [{ t: 0, s: { t: "A" } }] }], ["malformed", { k: [{ t: 0, s: {} }] }]] as const) {
    input.layers[1].t.d = document; fs.writeFileSync(source, JSON.stringify(input));
    const imported = path.join(root, `${name}.json`), rejected = path.join(root, `${name}-rejected.json`);
    runLottieImport([`--project=${project}`, "--scene=animation", "--append", `--source=${source}`, `--out=${imported}`]);
    runLottieImport([`--project=${imported}`, "--scene=animation"]);
    expect(JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)![0])).layers[1]).toMatchObject({ text: null, editableText: false });
    expect(() => runLottieImport([`--project=${imported}`, "--scene=animation", "--layer-index=1", "--layer-text=change", `--out=${rejected}`])).toThrow(/关键帧/);
    expect(fs.existsSync(rejected)).toBe(false);
  }
});

it("validates edited glyphs against the exact exported font and leaves inputs untouched", () => {
  const { input, source, project, out, root } = fixture(); vi.spyOn(console, "log").mockImplementation(() => {});
  input.fonts = { list: [{ fName: "RegularName", fFamily: "Example", fStyle: "Regular" }, { fName: "BoldName", fFamily: "Example", fStyle: "Bold" }] };
  input.chars = [
    ...["A", " ", "😀", "👩‍💻", "कि", "🇨🇳"].map(ch => ({ ch, fFamily: "Example", style: "Regular", w: 60, data: { shapes: [] } })),
    { ch: "B", fFamily: "Example", style: "Bold", w: 60, data: { shapes: [] } },
    { ch: "C", fFamily: "Other", style: "Regular", w: 60, data: { shapes: [] } },
  ];
  input.layers.push({ ty: 5, nm: "Text", t: { d: { k: [{ t: 0, s: { t: "A", f: "RegularName" } }] } } });
  fs.writeFileSync(source, JSON.stringify(input));
  runLottieImport([`--project=${project}`, "--scene=animation", "--append", `--source=${source}`, `--out=${out}`]);
  const originalSource = fs.readFileSync(source), originalProject = fs.readFileSync(out);
  const cli = fileURLToPath(new URL("./glint.ts", import.meta.url)), tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
  const env = { ...process.env, HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, TEMP: root, TMP: root };
  for (const [n, text] of ["B", "C", "Z", "A\n", "👩‍🚀"].entries()) {
    const rejected = path.join(root, `missing-${n}.json`);
    const result = spawnSync(process.execPath, ["--import", tsx, cli, "lottie-import", `--project=${out}`, "--scene=animation", "--layer-index=1", `--layer-text=${text}`, `--out=${rejected}`], { cwd: root, env, encoding: "utf8", timeout: 30000 });
    expect(result.status).not.toBe(0); expect(result.stderr + result.stdout).toMatch(/字形表缺少/);
    expect(fs.existsSync(rejected)).toBe(false);
  }
  const accepted = path.join(root, "covered.json"), replacement = "A 😀👩‍💻कि🇨🇳\rA";
  runLottieImport([`--project=${out}`, "--scene=animation", "--layer-index=1", `--layer-text=${replacement}`, `--out=${accepted}`]);
  const scene = parseProject(JSON.parse(fs.readFileSync(accepted, "utf8"))).scenes[1]!;
  if (scene.kind !== "html") throw new Error("Expected html");
  const expected = structuredClone(input); expected.layers[1].t.d.k[0].s.t = replacement;
  expect(readImportedLottie(scene).source).toEqual(expected);
  expect(fs.readFileSync(source)).toEqual(originalSource); expect(fs.readFileSync(out)).toEqual(originalProject);
  const empty = path.join(root, "glyph-empty.json");
  runLottieImport([`--project=${out}`, "--scene=animation", "--layer-index=1", "--layer-text=", `--out=${empty}`]);
  const bold = structuredClone(input); bold.layers[1].t.d.k[0].s.f = "BoldName"; fs.writeFileSync(source, JSON.stringify(bold));
  const boldProject = path.join(root, "bold.json"), boldEdited = path.join(root, "bold-edited.json");
  runLottieImport([`--project=${project}`, "--scene=animation", "--append", `--source=${source}`, `--out=${boldProject}`]);
  runLottieImport([`--project=${boldProject}`, "--scene=animation", "--layer-index=1", "--layer-text=B", `--out=${boldEdited}`]);
  expect(() => runLottieImport([`--project=${boldProject}`, "--scene=animation", "--layer-index=1", "--layer-text=A", `--out=${path.join(root, "bold-rejected.json")}`])).toThrow(/字形表缺少/);
  for (const [n, alter] of [
    (value: any) => { value.chars = []; },
    (value: any) => { value.fonts.list[0].fStyle = undefined; },
    (value: any) => { value.layers[1].t.d.k[0].s.f = "unknown"; },
    (value: any) => { value.chars = {}; },
  ].entries()) {
    const data = structuredClone(input); alter(data); fs.writeFileSync(source, JSON.stringify(data));
    const imported = path.join(root, `font-${n}.json`), rejected = path.join(root, `font-rejected-${n}.json`);
    runLottieImport([`--project=${project}`, "--scene=animation", "--append", `--source=${source}`, `--out=${imported}`]);
    const before = fs.readFileSync(imported);
    expect(() => runLottieImport([`--project=${imported}`, "--scene=animation", "--layer-index=1", "--layer-text=A", `--out=${rejected}`])).toThrow(/字形表|字体/);
    expect(fs.existsSync(rejected)).toBe(false); expect(fs.readFileSync(imported)).toEqual(before);
    runLottieImport([`--project=${imported}`, "--scene=animation", "--opacity=0.5", `--out=${path.join(root, `other-${n}.json`)}`]);
  }
});

it("imports and tunes Lottie into new projects without changing unrelated scenes", () => {
  const { root, project, out, source } = fixture(), log = vi.spyOn(console, "log").mockImplementation(() => {}), before = fs.readFileSync(project, "utf8");
  runLottieImport([`--project=${project}`, "--scene=animation", "--append", `--source=${source}`, "--scale=1.5", "--opacity=0.5", `--out=${out}`]);
  expect(fs.readFileSync(project, "utf8")).toBe(before);
  const created = parseProject(JSON.parse(fs.readFileSync(out, "utf8"))), scene = created.scenes[1]!;
  if (scene.kind !== "html") throw new Error("Expected html");
  expect(readImportedLottie(scene).settings).toMatchObject({ scale: 1.5, opacity: 0.5, speed: 1 });
  runLottieImport([`--project=${out}`, "--scene=animation"]);
  expect(JSON.parse(String(log.mock.calls.at(-1)![0]))).toMatchObject({ scale: 1.5, opacity: 0.5, speed: 1 });
  const updated = path.join(root, "updated.json");
  runLottieImport([`--project=${out}`, "--scene=animation", "--speed=2", "--opacity=1", `--out=${updated}`]);
  const edited = parseProject(JSON.parse(fs.readFileSync(updated, "utf8"))); expect(edited.scenes[0]).toEqual(created.scenes[0]);
  const result = edited.scenes[1]!; if (result.kind !== "html") throw new Error("Expected html");
  expect(readImportedLottie(result).settings).toMatchObject({ speed: 2, opacity: 1, scale: 1.5 });
  expect(result.narration.durationMs).toBe(scene.narration.durationMs);
  expect(() => runLottieImport([`--project=${out}`, "--scene=animation", "--speed=0.5", `--out=${path.join(root, "too-slow.json")}`])).toThrow(/镜长/);
});
it("inspects and edits one top-level static layer opacity without altering other layers", () => {
  const { input, source, project, out, root } = fixture(), log = vi.spyOn(console, "log").mockImplementation(() => {});
  const second = structuredClone(input.layers[0]); second.nm = "Second"; second.ind = 2; second.ks.a = { a: 0, k: [12, 34, 56] }; input.layers.push(second);
  fs.writeFileSync(source, JSON.stringify(input)); const before = fs.readFileSync(source);
  runLottieImport([`--project=${project}`, "--scene=animation", "--append", `--source=${source}`, `--out=${out}`]);
  runLottieImport([`--project=${out}`, "--scene=animation"]);
  expect(JSON.parse(String(log.mock.calls.at(-1)![0])).layers).toEqual([
    { index: 0, name: "Rectangle", opacity: 100, anchor: "0,0,0", position: null, scale: "100,100,100", rotation: 0, editableOpacity: true, positionKeyframes: [{ index: 0, frame: 0, value: "260,250,0", editable: true }, { index: 1, frame: 12, value: "540,250,0", editable: true }], fills: [{ path: "1", color: [0.4, 0.7, 1, 1], editable: true }], strokes: [] },
    { index: 1, name: "Second", opacity: 100, anchor: "12,34,56", position: null, scale: "100,100,100", rotation: 0, editableOpacity: true, positionKeyframes: [{ index: 0, frame: 0, value: "260,250,0", editable: true }, { index: 1, frame: 12, value: "540,250,0", editable: true }], fills: [{ path: "1", color: [0.4, 0.7, 1, 1], editable: true }], strokes: [] },
  ]);
  const changed = path.join(root, "layer.json");
  runLottieImport([`--project=${out}`, "--scene=animation", "--layer-index=0", "--layer-opacity=25", `--out=${changed}`]);
  const scene = parseProject(JSON.parse(fs.readFileSync(changed, "utf8"))).scenes[1]!;
  if (scene.kind !== "html") throw new Error("Expected html");
  const result = readImportedLottie(scene).source.layers as any[];
  expect(result[0].ks.o.k).toBe(25); expect(result[1]).toEqual(second);
  expect(fs.readFileSync(source)).toEqual(before);
  for (const args of [
    ["--layer-index=0"], ["--layer-opacity=20"], ["--layer-index=-1", "--layer-opacity=20"],
    ["--layer-index=2", "--layer-opacity=20"], ["--layer-index=0", "--layer-opacity=101"],
    ["--layer-index=0", "--layer-opacity="],
  ]) expect(() => runLottieImport([`--project=${out}`, "--scene=animation", ...args, `--out=${path.join(root, "bad.json")}`])).toThrow();
  expect(fs.existsSync(path.join(root, "bad.json"))).toBe(false);
});
it("refuses to overwrite animated layer opacity", () => {
  const { input, source, project, out, root } = fixture(); vi.spyOn(console, "log").mockImplementation(() => {});
  input.layers[0].ks.o = { a: 1, k: [{ t: 0, s: [100] }, { t: 12, s: [0] }] };
  fs.writeFileSync(source, JSON.stringify(input));
  runLottieImport([`--project=${project}`, "--scene=animation", "--append", `--source=${source}`, `--out=${out}`]);
  expect(() => runLottieImport([`--project=${out}`, "--scene=animation", "--layer-index=0", "--layer-opacity=0", `--out=${path.join(root, "changed.json")}`])).toThrow(/关键帧/);
  expect(fs.existsSync(path.join(root, "changed.json"))).toBe(false);
});
it("edits an existing opacity keyframe without changing timing or other data", () => {
  const { input, source, project, out, root } = fixture(), log = vi.spyOn(console, "log").mockImplementation(() => {});
  input.layers[0].ks.o = { a: 1, k: [{ t: 0, s: [100], e: [60], o: { x: [0.33], y: [0.33] }, i: { x: [0.67], y: [0.67] } }, { t: 12, s: [60], e: [0] }, { t: 24, s: [0] }] };
  fs.writeFileSync(source, JSON.stringify(input));
  runLottieImport([`--project=${project}`, "--scene=animation", "--append", `--source=${source}`, `--out=${out}`]);
  runLottieImport([`--project=${out}`, "--scene=animation"]);
  expect(JSON.parse(String(log.mock.calls.at(-1)![0])).layers[0].opacityKeyframes).toEqual([{ index: 0, frame: 0, value: 100 }, { index: 1, frame: 12, value: 60 }, { index: 2, frame: 24, value: 0 }]);
  const changed = path.join(root, "keyframe.json"), before = fs.readFileSync(out);
  runLottieImport([`--project=${out}`, "--scene=animation", "--layer-index=0", "--opacity-keyframe=1", "--keyframe-opacity=20", `--out=${changed}`]);
  const scene = parseProject(JSON.parse(fs.readFileSync(changed, "utf8"))).scenes[1]!;
  if (scene.kind !== "html") throw new Error("Expected html");
  const expected = structuredClone(input); expected.layers[0].ks.o.k[0].e = [20]; expected.layers[0].ks.o.k[1].s = [20];
  expect(readImportedLottie(scene).source).toEqual(expected);
  expect(fs.readFileSync(out)).toEqual(before);
  for (const args of [["--opacity-keyframe=1", "--keyframe-opacity=10"], ["--layer-index=0", "--opacity-keyframe=1"], ["--layer-index=0", "--keyframe-opacity=10"], ["--layer-index=0", "--opacity-keyframe=-1", "--keyframe-opacity=10"], ["--layer-index=0", "--opacity-keyframe=3", "--keyframe-opacity=10"], ["--layer-index=0", "--opacity-keyframe=1", "--keyframe-opacity=101"], ["--layer-index=0", "--opacity-keyframe=1", "--keyframe-opacity=",], ["--layer-index=0", "--opacity-keyframe=1", "--keyframe-opacity=10", "--layer-opacity=10"]]) {
    const bad = path.join(root, "invalid-keyframe.json");
    expect(() => runLottieImport([`--project=${out}`, "--scene=animation", ...args, `--out=${bad}`])).toThrow();
    expect(fs.existsSync(bad)).toBe(false);
  }
  for (const [name, keys] of [["mismatch", [{ t: 0, s: [100], e: [20] }, { t: 12, s: [60] }]], ["time", [{ t: 0, s: [100] }, { t: 0, s: [60] }]], ["missing", [{ t: 0, s: [100] }, { t: 12 }]]] as const) {
    input.layers[0].ks.o.k = keys; fs.writeFileSync(source, JSON.stringify(input));
    const imported = path.join(root, `invalid-source-${name}.json`);
    runLottieImport([`--project=${project}`, "--scene=animation", "--append", `--source=${source}`, `--out=${imported}`]);
    const bad = path.join(root, "invalid-keyframe.json");
    expect(() => runLottieImport([`--project=${imported}`, "--scene=animation", "--layer-index=0", "--opacity-keyframe=1", "--keyframe-opacity=10", `--out=${bad}`])).toThrow();
    expect(fs.existsSync(bad)).toBe(false);
  }
});

it("moves an existing opacity keyframe only between its neighbors and preserves the source", () => {
  const { input, source, project, out, root } = fixture(); vi.spyOn(console, "log").mockImplementation(() => {});
  input.op = 36;
  input.layers[0].ks.o = { a: 1, k: [{ t: 0, s: [100], e: [50], o: { x: [0.3], y: [0.4] } }, { t: 12, s: [50], e: [0] }, { t: 24, s: [0] }] };
  fs.writeFileSync(source, JSON.stringify(input));
  runLottieImport([`--project=${project}`, "--scene=animation", "--append", `--source=${source}`, `--out=${out}`]);
  const original = fs.readFileSync(out), originalSource = fs.readFileSync(source), changed = path.join(root, "moved.json");
  const cli = fileURLToPath(new URL("./glint.ts", import.meta.url)), tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
  const edit = spawnSync(process.execPath, ["--import", tsx, cli, "lottie-import", `--project=${out}`, "--scene=animation", "--layer-index=0", "--opacity-keyframe=1", "--keyframe-frame=18.5", `--out=${changed}`], { encoding: "utf8", timeout: 30000 });
  expect(edit.status, edit.stderr).toBe(0);
  const scene = parseProject(JSON.parse(fs.readFileSync(changed, "utf8"))).scenes[1]!;
  if (scene.kind !== "html") throw new Error("Expected html");
  const expected = structuredClone(input); expected.layers[0].ks.o.k[1].t = 18.5;
  expect(readImportedLottie(scene).source).toEqual(expected);
  expect(fs.readFileSync(out)).toEqual(original); expect(fs.readFileSync(source)).toEqual(originalSource);
  for (const args of [
    ["--layer-index=0", "--keyframe-frame=5"], ["--opacity-keyframe=1", "--keyframe-frame=5"],
    ["--layer-index=0", "--opacity-keyframe=1", "--keyframe-frame="], ["--layer-index=0", "--opacity-keyframe=1", "--keyframe-frame=NaN"],
    ["--layer-index=0", "--opacity-keyframe=1", "--keyframe-frame=0"], ["--layer-index=0", "--opacity-keyframe=1", "--keyframe-frame=24"],
    ["--layer-index=0", "--opacity-keyframe=0", `--keyframe-frame=${input.op}`], ["--layer-index=0", "--opacity-keyframe=0", `--keyframe-frame=${input.ip - 1}`],
    ["--layer-index=0", "--opacity-keyframe=1", "--keyframe-frame=5", "--layer-opacity=10"],
  ]) {
    const bad = path.join(root, "bad-move.json");
    expect(() => runLottieImport([`--project=${out}`, "--scene=animation", ...args, `--out=${bad}`])).toThrow();
    expect(fs.existsSync(bad)).toBe(false);
  }
  expect(() => runLottieImport([`--project=${out}`, "--scene=animation", "--layer-index=0", "--opacity-keyframe=1", "--keyframe-frame=5", `--out=${out}`])).toThrow();
  expect(fs.readFileSync(out)).toEqual(original);
});

it("edits a position keyframe value without changing timing, easing or other data", () => {
  const { input, source, project, out, root } = fixture(), log = vi.spyOn(console, "log").mockImplementation(() => {});
  // 夹具第一层位置就是旧式关键帧(s/e/i/o);另一层用 2D 无 e 的简式关键帧作为隔离样本。
  const flat = structuredClone(input.layers[0]); flat.nm = "Flat"; flat.ind = 2;
  flat.ks.p = { a: 1, k: [{ t: 0, s: [10, 20] }, { t: 6, s: [30, 40], h: 1 }, { t: 12, s: [50, 60] }] };
  const split = structuredClone(input.layers[0]); split.nm = "Split"; split.ind = 3;
  split.ks.p = { a: 1, s: true, x: { a: 1, k: [{ t: 0, s: [10] }] }, y: { a: 0, k: 20 } };
  input.layers.push(flat, split);
  fs.writeFileSync(source, JSON.stringify(input));
  runLottieImport([`--project=${project}`, "--scene=animation", "--append", `--source=${source}`, `--out=${out}`]);
  runLottieImport([`--project=${out}`, "--scene=animation"]);
  const report = JSON.parse(String(log.mock.calls.filter(call => String(call[0]).startsWith("{")).at(-1)![0]));
  expect(report.layers[0].positionKeyframes).toEqual([{ index: 0, frame: 0, value: "260,250,0", editable: true }, { index: 1, frame: 12, value: "540,250,0", editable: true }]);
  expect(report.layers[1].positionKeyframes).toEqual([{ index: 0, frame: 0, value: "10,20", editable: true }, { index: 1, frame: 6, value: "30,40", editable: true }, { index: 2, frame: 12, value: "50,60", editable: true }]);
  expect(report.layers[2].positionKeyframes).toBeUndefined();
  const before = fs.readFileSync(out), originalSource = fs.readFileSync(source);
  // 编辑末帧值:前一关键帧的 e 终值必须同步,缓动与时间保持不变。
  const changed = path.join(root, "position-keyframe.json");
  runLottieImport([`--project=${out}`, "--scene=animation", "--layer-index=0", "--position-keyframe=1", "--keyframe-pos=300,180", `--out=${changed}`]);
  const scene = parseProject(JSON.parse(fs.readFileSync(changed, "utf8"))).scenes[1]!;
  if (scene.kind !== "html") throw new Error("Expected html");
  const expected = structuredClone(input);
  expected.layers[0].ks.p.k[0].e = [300, 180, 0];
  expected.layers[0].ks.p.k[1].s = [300, 180, 0];
  expect(readImportedLottie(scene).source).toEqual(expected);
  expect(fs.readFileSync(out)).toEqual(before); expect(fs.readFileSync(source)).toEqual(originalSource);
  // 首帧值编辑不动 e 终值(该 e 属于段落末值,由下一段起点编辑负责)。
  const firstChanged = path.join(root, "position-first.json");
  runLottieImport([`--project=${out}`, "--scene=animation", "--layer-index=0", "--position-keyframe=0", "--keyframe-pos=100,80", `--out=${firstChanged}`]);
  const firstScene = parseProject(JSON.parse(fs.readFileSync(firstChanged, "utf8"))).scenes[1]!;
  if (firstScene.kind !== "html") throw new Error("Expected html");
  expect((readImportedLottie(firstScene).source.layers[0] as any).ks.p.k[0].s).toEqual([100, 80, 0]);
  expect((readImportedLottie(firstScene).source.layers[0] as any).ks.p.k[0].e).toEqual([540, 250, 0]);
  // 2D 简式关键帧:只改 x,y,保留 hold 标记。
  const flatChanged = path.join(root, "position-flat.json");
  runLottieImport([`--project=${out}`, "--scene=animation", "--layer-index=1", "--position-keyframe=1", "--keyframe-pos=-5,60", `--out=${flatChanged}`]);
  const flatScene = parseProject(JSON.parse(fs.readFileSync(flatChanged, "utf8"))).scenes[1]!;
  if (flatScene.kind !== "html") throw new Error("Expected html");
  expect((readImportedLottie(flatScene).source.layers[1] as any).ks.p.k[1]).toEqual({ t: 6, s: [-5, 60], h: 1 });
  // 不合法输入全部拒绝且不产生输出。
  for (const args of [
    ["--keyframe-pos=1,2"], ["--layer-index=0", "--keyframe-pos=1,2"], ["--layer-index=0", "--position-keyframe=1"],
    ["--layer-index=0", "--position-keyframe=-1", "--keyframe-pos=1,2"], ["--layer-index=0", "--position-keyframe=2", "--keyframe-pos=1,2"],
    ["--layer-index=0", "--position-keyframe=1", "--keyframe-pos=1"], ["--layer-index=0", "--position-keyframe=1", "--keyframe-pos=1,2,3"],
    ["--layer-index=0", "--position-keyframe=1", "--keyframe-pos=,2"], ["--layer-index=0", "--position-keyframe=1", "--keyframe-pos=1, "],
    ["--layer-index=0", "--position-keyframe=1", "--keyframe-pos=nan,0"], ["--layer-index=0", "--position-keyframe=1", "--keyframe-pos=100001,0"],
    ["--layer-index=0", "--position-keyframe=1", "--keyframe-pos="], ["--layer-index=0", "--position-keyframe=1", "--keyframe-pos=1,2", "--layer-pos=3,4"],
    ["--layer-index=2", "--position-keyframe=0", "--keyframe-pos=1,2"],
  ]) {
    const bad = path.join(root, "bad-position.json");
    expect(() => runLottieImport([`--project=${out}`, "--scene=animation", ...args, `--out=${bad}`])).toThrow();
    expect(fs.existsSync(bad)).toBe(false);
  }
  expect(fs.readFileSync(out)).toEqual(before);
  // 不一致的前关键帧 e 值拒绝编辑,保护不一致的旧格式文件。
  input.layers[0].ks.p.k[0].e = [999, 250, 0]; fs.writeFileSync(source, JSON.stringify(input));
  const inconsistent = path.join(root, "inconsistent.json");
  runLottieImport([`--project=${project}`, "--scene=animation", "--append", `--source=${source}`, `--out=${inconsistent}`]);
  const rejected = path.join(root, "inconsistent-rejected.json");
  expect(() => runLottieImport([`--project=${inconsistent}`, "--scene=animation", "--layer-index=0", "--position-keyframe=1", "--keyframe-pos=1,2", `--out=${rejected}`])).toThrow(/不一致/);
  expect(fs.existsSync(rejected)).toBe(false);
});

it("rejects expressions, external assets, malformed data and unsafe text injection", () => {
  const { input } = fixture();
  expect(() => validateLottie({ ...input, assets: [{ u: "https://example.com/" }] })).toThrow(/外部/);
  expect(() => validateLottie({ ...input, assets: [{ p: "https://example.com/image.png" }] })).toThrow(/外部/);
  expect(() => validateLottie({ ...input, assets: [{ p: "data:image/svg+xml;base64,PHN2Zz4=" }] })).toThrow(/外部/);
  expect(() => validateLottie({ ...input, layers: [{ x: "alert(1)" }] })).toThrow(/表达式/);
  expect(() => validateLottie({ ...input, fonts: { list: [{ fPath: "https://example.com/font.woff2" }] } })).toThrow(/外部字体/);
  expect(() => validateLottie({ ...input, layers: [{ p: { k: Infinity } }] })).toThrow(/数值/);
  expect(() => validateLottie({ ...input, fr: 0 })).toThrow(/帧率/);
  const parsed = JSON.parse('{"__proto__":{"bad":true},"fr":24,"ip":0,"op":12,"w":100,"h":100,"layers":[{}]}');
  expect(() => validateLottie(parsed)).toThrow(/字段/);
});
it("escapes a script terminator and refuses tampering, locks and overwriting", () => {
  const { input, source, project, out, root } = fixture(); vi.spyOn(console, "log").mockImplementation(() => {});
  input.nm = "</script><script>bad()</script>"; fs.writeFileSync(source, JSON.stringify(input));
  runLottieImport([`--project=${project}`, "--scene=animation", "--append", `--source=${source}`, `--out=${out}`]);
  const created = parseProject(JSON.parse(fs.readFileSync(out, "utf8"))), scene = created.scenes[1]!;
  if (scene.kind !== "html") throw new Error("Expected html");
  expect(scene.html).not.toContain("</script><script>bad()");
  expect(readImportedLottie(scene).source.nm).toBe("</script><script>bad()</script>");
  expect(() => runLottieImport([`--project=${out}`, "--scene=animation", "--scale=2", `--out=${out}`])).toThrow();
  scene.html += "<p>edit</p>"; fs.writeFileSync(out, JSON.stringify(created));
  expect(() => runLottieImport([`--project=${out}`, "--scene=animation", "--scale=2", `--out=${path.join(root, "edited.json")}`])).toThrow(/手动修改/);
  scene.locked = true; fs.writeFileSync(out, JSON.stringify(created));
  expect(() => runLottieImport([`--project=${out}`, "--scene=animation", "--scale=2", `--out=${path.join(root, "edited.json")}`])).toThrow(/locked/);
});
it("reaches the importer through the actual CLI", () => {
  const { source, project, out, root } = fixture(), cli = fileURLToPath(new URL("./glint.ts", import.meta.url)), tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
  const result = spawnSync(process.execPath, ["--import", tsx, cli, "lottie-import", `--project=${project}`, "--scene=animation", "--append", `--source=${source}`, "--scale=1.2", `--out=${out}`], { encoding: "utf8", timeout: 30000 });
  expect(result.status, result.stderr).toBe(0); expect(parseProject(JSON.parse(fs.readFileSync(out, "utf8"))).scenes).toHaveLength(2);
  const changed = path.join(root, "cli-layer.json");
  const edit = spawnSync(process.execPath, ["--import", tsx, cli, "lottie-import", `--project=${out}`, "--scene=animation", "--layer-index=0", "--layer-opacity=0", `--out=${changed}`], { encoding: "utf8", timeout: 30000 });
  expect(edit.status, edit.stderr).toBe(0);
  const scene = parseProject(JSON.parse(fs.readFileSync(changed, "utf8"))).scenes[1]!;
  if (scene.kind !== "html") throw new Error("Expected html");
  expect((readImportedLottie(scene).source.layers[0] as any).ks.o.k).toBe(0);
  const colorFile = path.join(root, "cli-fill.json");
  const color = spawnSync(process.execPath, ["--import", tsx, cli, "lottie-import", `--project=${out}`, "--scene=animation", "--layer-index=0", "--fill-path=1", "--fill-color=#FF0000", `--out=${colorFile}`], { encoding: "utf8", timeout: 30000 });
  expect(color.status, color.stderr).toBe(0);
  const colorScene = parseProject(JSON.parse(fs.readFileSync(colorFile, "utf8"))).scenes[1]!;
  if (colorScene.kind !== "html") throw new Error("Expected html");
  expect((readImportedLottie(colorScene).source.layers[0] as any).shapes[1].c.k).toEqual([1, 0, 0, 1]);
});

it("edits one layer's static position, scale and rotation while keeping the other layer untouched", () => {
  const { root, project, out, source, input } = fixture(), log = vi.spyOn(console, "log").mockImplementation(() => {});
  // 夹具只有一层且位置是关键帧;克隆出第二层、给静态位置再编辑,第一层保持关键帧作为拒绝样本。
  const second = structuredClone(input.layers[0]); second.nm = "Second"; second.ind = 2; input.layers.push(second);
  (input.layers[1].ks as Record<string, unknown>).p = { a: 0, k: [10, 20, 0] };
  fs.writeFileSync(source, JSON.stringify(input));
  runLottieImport([`--project=${project}`, "--scene=animation", "--append", `--source=${source}`, `--out=${out}`]);
  const changed = path.join(root, "layer-transform.json");
  runLottieImport([`--project=${out}`, "--scene=animation", "--layer-index=1", "--layer-pos=-40,60", "--layer-scale=150,80", "--layer-rotation=45", `--out=${changed}`]);
  const scene = parseProject(JSON.parse(fs.readFileSync(changed, "utf8"))).scenes[1]!;
  if (scene.kind !== "html") throw new Error("Expected html");
  const layers = readImportedLottie(scene).source.layers as Array<{ ks: Record<string, { a?: number; k: unknown }>; nm: string }>;
  expect(layers[1]!.ks.p).toEqual({ a: 0, k: [-40, 60, 0] });
  expect(layers[1]!.ks.s).toEqual({ a: 0, k: [150, 80, 100] });
  expect(layers[1]!.ks.r).toEqual({ a: 0, k: 45 });
  expect(layers[0]!.nm).toBe("Rectangle");
  expect(layers[0]!.ks.p).toEqual(input.layers[0]!.ks.p);
  expect(layers[0]!.ks.s).toEqual(input.layers[0]!.ks.s);
  runLottieImport([`--project=${changed}`, "--scene=animation"]);
  const listed = JSON.parse(String(log.mock.calls.filter(call => String(call[0]).startsWith("{")).at(-1)![0]));
  expect(listed.layers[1]).toMatchObject({ position: "-40,60,0", scale: "150,80,100", rotation: 45 });
  const rejects: string[][] = [
    ["--layer-pos=1"], ["--layer-pos=1,2,3"], ["--layer-pos=,2"], ["--layer-pos=1, "], ["--layer-pos=nan,0"], ["--layer-pos=100001,0"],
    ["--layer-scale=0,100"], ["--layer-scale=10001,100"], ["--layer-rotation=3601"], ["--layer-rotation="],
    ["--layer-index=0", "--layer-pos=1,2"], // 第一层位置是关键帧,拒绝
  ];
  for (const args of rejects) expect(() => runLottieImport([`--project=${out}`, "--scene=animation", ...args, `--out=${path.join(root, "bad.json")}`])).toThrow();
  expect(fs.existsSync(path.join(root, "bad.json"))).toBe(false);
});

it("edits static nested stroke colors and recovers after rejected edits", () => {
  const { root, input, source, project, out } = fixture();
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  input.layers[0].shapes.push({ ty: "gr", it: [{ ty: "st", c: { a: 0, k: [1, 0, 0, 0.5] }, o: { a: 0, k: 80 }, w: { a: 0, k: 12 } }, { ty: "st", c: { a: 1, k: [{ t: 0, s: [1, 0, 0, 1] }] } }] });
  fs.writeFileSync(source, JSON.stringify(input));
  runLottieImport([`--project=${project}`, "--scene=animation", "--append", `--source=${source}`, `--out=${out}`]);
  const before = fs.readFileSync(out), originalSource = fs.readFileSync(source);
  runLottieImport([`--project=${out}`, "--scene=animation"]);
  expect(JSON.parse(String(log.mock.calls.at(-1)![0])).layers[0].strokes).toEqual([{ path: "2.0", color: [1, 0, 0, 0.5], editable: true }, { path: "2.1", color: null, editable: false }]);
  for (const flags of [["--stroke-path=2.0", "--stroke-color=#fff"], ["--stroke-path=2.1", "--stroke-color=#00ff00"], ["--stroke-path=1", "--stroke-color=#00ff00"], ["--stroke-path=2.0"], ["--stroke-color=#00ff00"]]) {
    const rejected = path.join(root, "rejected.json");
    expect(() => runLottieImport([`--project=${out}`, "--scene=animation", "--layer-index=0", ...flags, `--out=${rejected}`])).toThrow();
    expect(fs.existsSync(rejected)).toBe(false); expect(fs.readFileSync(out)).toEqual(before);
  }
  const changed = path.join(root, "recovered.json");
  const cli = fileURLToPath(new URL("./glint.ts", import.meta.url)), tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
  const env = { ...process.env, HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, TEMP: root, TMP: root };
  const result = spawnSync(process.execPath, ["--import", tsx, cli, "lottie-import", `--project=${out}`, "--scene=animation", "--layer-index=0", "--stroke-path=2.0", "--stroke-color=#00FF80", `--out=${changed}`], { cwd: root, env, encoding: "utf8", timeout: 30000 });
  expect(result.status, result.stderr).toBe(0);
  const scene = parseProject(JSON.parse(fs.readFileSync(changed, "utf8"))).scenes[1]!;
  if (scene.kind !== "html") throw new Error("Expected html");
  const expected = structuredClone(input); expected.layers[0].shapes[2].it[0].c.k = [0, 1, 128 / 255, 0.5];
  expect(readImportedLottie(scene).source).toEqual(expected);
  expect(fs.readFileSync(source)).toEqual(originalSource); expect(fs.readFileSync(out)).toEqual(before);
});

it("edits exactly one nested static fill, preserves alpha and rejects unsafe targets", () => {

  const { root, project, out, source, input } = fixture(), log = vi.spyOn(console, "log").mockImplementation(() => {});

  const layer = input.layers[0], fill = structuredClone(layer.shapes[1]); fill.c.k[3] = 0.25;

  layer.shapes.push({ ty: "gr", it: [fill, structuredClone(fill)] });

  layer.shapes.push({ ty: "fl", c: { a: 1, k: [{ t: 0, s: [1, 0, 0, 1] }] } });

  layer.shapes.push({ ty: "fl", c: { a: 0, k: [{ t: 0, s: [1, 0, 0, 1] }] } });

  input.layers.push(structuredClone(layer)); input.layers[1].ind = 2;

  fs.writeFileSync(source, JSON.stringify(input));

  runLottieImport([`--project=${project}`, "--scene=animation", "--append", `--source=${source}`, `--out=${out}`]);

  runLottieImport([`--project=${out}`, "--scene=animation"]);

  const inspected = JSON.parse(String(log.mock.calls.at(-1)![0]));

  expect(inspected.layers[0].fills).toContainEqual({ path: "2.1", color: [0.4, 0.7, 1, 0.25], editable: true });

  expect(inspected.layers[0].fills).toContainEqual({ path: "3", color: null, editable: false });

  const changed = path.join(root, "fill.json");

  runLottieImport([`--project=${out}`, "--scene=animation", "--layer-index=0", "--fill-path=2.1", "--fill-color=#FF0080", `--out=${changed}`]);

  const scene = parseProject(JSON.parse(fs.readFileSync(changed, "utf8"))).scenes[1]!;

  if (scene.kind !== "html") throw new Error("Expected html");

  const expected = structuredClone(input); expected.layers[0].shapes[2].it[1].c.k = [1, 0, 128 / 255, 0.25];

  expect(readImportedLottie(scene).source).toEqual(expected);

  expect(JSON.parse(fs.readFileSync(source, "utf8"))).toEqual(input);

  for (const args of [

    ["--fill-path=1", "--fill-color=#123456"], ["--layer-index=0", "--fill-path=1"],

    ["--layer-index=0", "--fill-color=#123456"], ["--layer-index=0", "--fill-path=01", "--fill-color=#123456"],

    ["--layer-index=0", "--fill-path=0", "--fill-color=#123456"], ["--layer-index=0", "--fill-path=9", "--fill-color=#123456"],

    ["--layer-index=0", "--fill-path=1", "--fill-color=red"], ["--layer-index=0", "--fill-path=3", "--fill-color=#123456"],

    ["--layer-index=0", "--fill-path=4", "--fill-color=#123456"],

  ]) {

    const bad = path.join(root, "bad-fill.json");

    expect(() => runLottieImport([`--project=${out}`, "--scene=animation", ...args, `--out=${bad}`])).toThrow();

    expect(fs.existsSync(bad)).toBe(false);

  }

  for (const unsafe of [{ x: "thisComp.layer(1)" }, { assets: [{ u: "file:///tmp/" }] }, { layers: [{ ...layer, shapes: [{ ty: "fl", c: { a: 0, k: [1, 0, 0], x: "value" } }] }] }]) {

    const bad = path.join(root, "unsafe.json"); fs.writeFileSync(source, JSON.stringify({ ...input, ...unsafe }));

    expect(() => runLottieImport([`--project=${project}`, "--scene=unsafe", "--append", `--source=${source}`, `--out=${bad}`])).toThrow();

    expect(fs.existsSync(bad)).toBe(false);

  }

});

/** Real decodable raster fixtures for embedded-asset restore; generated once per format. */
const imageFixtures = new Map<string, Buffer>();
function imageFixture(kind: "png" | "jpg" | "webp"): Buffer {
  const cached = imageFixtures.get(kind);
  if (cached) return cached;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glint-lottie-image-"));
  const file = path.join(dir, `fixture.${kind}`);
  const color = { png: "red", jpg: "lime", webp: "blue" }[kind];
  execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", `color=c=${color}:size=8x8`, "-frames:v", "1", file], { timeout: 60_000 });
  const bytes = fs.readFileSync(file);
  fs.rmSync(dir, { recursive: true, force: true });
  imageFixtures.set(kind, bytes);
  return bytes;
}

function assetProject() {
  const base = fixture(), png = imageFixture("png"), jpg = imageFixture("jpg"), webp = imageFixture("webp");
  const dataUrl = (bytes: Buffer, mime: string) => `data:image/${mime};base64,${bytes.toString("base64")}`;
  base.input.assets = [
    { id: "img_png", w: 8, h: 8, u: "", p: dataUrl(png, "png") },
    { id: "img_jpg", w: 8, h: 8, u: "", p: dataUrl(jpg, "jpeg") },
    { id: "img_png_again", w: 8, h: 8, u: "", p: dataUrl(png, "png") },
    { id: "img_webp", w: 8, h: 8, u: "", p: dataUrl(webp, "webp") },
    { id: "comp_pre", layers: [{ ddd: 0, ind: 1, ty: 2, refId: "img_png", sr: 1, ks: {}, ao: 0, ip: 0, op: 12, st: 0, bm: 0 }], fr: 24, ip: 0, op: 12, w: 8, h: 8 },
  ];
  fs.writeFileSync(base.source, JSON.stringify(base.input));
  return { ...base, png, jpg, webp };
}

it("restores embedded images into a library with magic checks, exclusive writes and project read-back", () => {
  const { source, project, root, png, jpg, webp } = assetProject();
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  runLottieImport([`--project=${project}`, "--scene=animation", "--append", `--source=${source}`, `--out=${path.join(root, "imported.json")}`]);
  const imported = path.join(root, "imported.json"), library = path.join(root, "library");
  fs.mkdirSync(library);
  const beforeProject = fs.readFileSync(imported), beforeSource = fs.readFileSync(source);
  const restore = () => JSON.parse(String(log.mock.calls.filter(call => String(call[0]).startsWith("{")).at(-1)![0]));
  runLottieImport([`--project=${imported}`, "--scene=animation", `--save-assets=${library}`]);
  const receipt = restore();
  expect(receipt.saved).toHaveLength(3);
  const expected = [["png", png], ["jpg", jpg], ["webp", webp]] as const;
  for (const [kind, bytes] of expected) {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const entry = receipt.saved.find((item: { file: string }) => item.file === `lottie-${sha256}.${kind}`);
    expect(entry).toMatchObject({ sha256, bytes: bytes.length, state: "created" });
    expect(entry.assetIds).toEqual(kind === "png" ? ["img_png", "img_png_again"] : [`img_${kind}`]);
    const stored = fs.readFileSync(path.join(library, entry.file));
    expect(stored).toEqual(bytes);
  }
  expect(receipt.note).toMatch(/回读/);
  // 工程引用回读：重新解析工程、提取内嵌资源并与库文件逐哈希核对。
  const scene = parseProject(JSON.parse(fs.readFileSync(imported, "utf8"))).scenes[1]!;
  if (scene.kind !== "html") throw new Error("Expected html");
  const roundTrip = readImportedLottie(scene).source.assets as Array<{ p: string }>;
  const hashes = roundTrip.filter(asset => typeof asset.p === "string" && asset.p.startsWith("data:")).map(asset => createHash("sha256").update(Buffer.from(asset.p.replace(/^data:image\/[a-z]+;base64,/, ""), "base64")).digest("hex"));
  for (const entry of receipt.saved) expect(hashes).toContain(entry.sha256);
  // 幂等重跑：内容相同则只验证不覆盖，文件内容与修改时间不变。
  const before = Object.fromEntries(fs.readdirSync(library).map(name => [name, fs.statSync(path.join(library, name)).mtimeMs]));
  runLottieImport([`--project=${imported}`, "--scene=animation", `--save-assets=${library}`]);
  expect(restore().saved.every((item: { state: string }) => item.state === "verified")).toBe(true);
  for (const [name, mtime] of Object.entries(before)) expect(fs.statSync(path.join(library, name)).mtimeMs).toBe(mtime);
  // 库内同名文件被篡改时拒绝覆盖并保持原样。
  const victim = receipt.saved[0].file;
  fs.appendFileSync(path.join(library, victim), "x");
  const corrupted = fs.readFileSync(path.join(library, victim));
  expect(() => runLottieImport([`--project=${imported}`, "--scene=animation", `--save-assets=${library}`])).toThrow(/内容不一致/);
  expect(fs.readFileSync(path.join(library, victim))).toEqual(corrupted);
  expect(fs.readdirSync(library).filter(name => name.startsWith(".lottie-restore-"))).toEqual([]);
  // 工程与源素材始终未被修改。
  expect(fs.readFileSync(imported)).toEqual(beforeProject);
  expect(fs.readFileSync(source)).toEqual(beforeSource);
});

it("rejects restore on magic mismatch, tampered scenes, unsafe targets and flag misuse without writing", () => {
  const { source, project, root } = assetProject();
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  // 声明为 PNG、实际为 JPEG 字节的资源必须被魔数交叉校验拒绝。
  const mismatched = path.join(root, "mismatch.json");
  fs.writeFileSync(mismatched, JSON.stringify({ ...JSON.parse(fs.readFileSync(source, "utf8")), assets: [{ id: "liar", w: 8, h: 8, u: "", p: `data:image/png;base64,${imageFixture("jpg").toString("base64")}` }] }));
  runLottieImport([`--project=${project}`, "--scene=animation", "--append", `--source=${mismatched}`, `--out=${path.join(root, "mismatched-imported.json")}`]);
  const library = path.join(root, "library");
  fs.mkdirSync(library);
  expect(() => runLottieImport([`--project=${path.join(root, "mismatched-imported.json")}`, "--scene=animation", `--save-assets=${library}`])).toThrow(/魔数/);
  expect(fs.readdirSync(library)).toEqual([]);
  // 单字节非图片内容同样拒绝。
  const garbage = path.join(root, "garbage.json");
  fs.writeFileSync(garbage, JSON.stringify({ ...JSON.parse(fs.readFileSync(source, "utf8")), assets: [{ id: "garbage", w: 8, h: 8, u: "", p: "data:image/png;base64,AA==" }] }));
  const garbageImported = path.join(root, "garbage-imported.json");
  runLottieImport([`--project=${project}`, "--scene=animation", "--append", `--source=${garbage}`, `--out=${garbageImported}`]);
  expect(() => runLottieImport([`--project=${garbageImported}`, "--scene=animation", `--save-assets=${library}`])).toThrow(/魔数/);
  // 场景 HTML 被手动篡改后回库整体拒绝。
  const tampered = path.join(root, "tampered.json"), tamperedLibrary = path.join(root, "tampered-library");
  runLottieImport([`--project=${project}`, "--scene=animation", "--append", `--source=${source}`, `--out=${tampered}`]);
  const created = JSON.parse(fs.readFileSync(tampered, "utf8"));
  created.scenes[1].html += "<p>edit</p>";
  fs.writeFileSync(tampered, JSON.stringify(created));
  expect(() => runLottieImport([`--project=${tampered}`, "--scene=animation", `--save-assets=${tamperedLibrary}`])).toThrow(/手动修改/);
  expect(fs.existsSync(tamperedLibrary)).toBe(false);
  // 非 Lottie 镜头、缺失目录、文件目录、junction 目录均拒绝。
  const imported = path.join(root, "imported.json");
  runLottieImport([`--project=${project}`, "--scene=animation", "--append", `--source=${source}`, `--out=${imported}`]);
  expect(() => runLottieImport([`--project=${imported}`, "--scene=first", `--save-assets=${library}`])).toThrow(/已导入的 Lottie/);
  expect(() => runLottieImport([`--project=${imported}`, "--scene=animation", `--save-assets=${path.join(root, "missing")}`])).toThrow(/素材库目录不存在/);
  expect(() => runLottieImport([`--project=${imported}`, "--scene=animation", `--save-assets=${source}`])).toThrow(/普通目录/);
  const outside = path.join(root, "outside"), junction = path.join(root, "junction");
  fs.mkdirSync(outside); fs.symlinkSync(outside, junction, process.platform === "win32" ? "junction" : "dir");
  expect(() => runLottieImport([`--project=${imported}`, "--scene=animation", `--save-assets=${junction}`])).toThrow(/普通目录/);
  expect(fs.readdirSync(outside)).toEqual([]);
  // 参数误用：与编辑参数或输出组合、缺少参数一律拒绝且不产生输出。
  for (const args of [
    [`--project=${imported}`, "--scene=animation", `--save-assets=${library}`, `--out=${path.join(root, "bad.json")}`],
    [`--project=${imported}`, "--scene=animation", `--save-assets=${library}`, "--speed=2"],
    [`--project=${imported}`, "--scene=animation", "--save-assets"],
    [`--scene=animation`, `--save-assets=${library}`],
    [`--project=${imported}`, `--save-assets=${library}`],
    [`--inspect-source=${source}`, `--save-assets=${library}`],
  ]) {
    expect(() => runLottieImport(args)).toThrow();
    expect(fs.readdirSync(library)).toEqual([]);
    expect(fs.existsSync(path.join(root, "bad.json"))).toBe(false);
  }
});

it("rejects truncated and forged raster bodies before any asset is published", () => {
  const { input, source, project, root, png, jpg, webp } = assetProject();
  vi.spyOn(console, "log").mockImplementation(() => {});
  const library = path.join(root, "library"); fs.mkdirSync(library);
  const samples: Array<[string, Buffer]> = [
    ["png", png.subarray(0, 8)], ["png", Buffer.concat([png.subarray(0, 8), png.subarray(-12)])],
    ["jpeg", jpg.subarray(0, 3)], ["jpeg", Buffer.concat([jpg.subarray(0, 3), jpg.subarray(-2)])],
    ["webp", webp.subarray(0, 12)], ["webp", Buffer.from("524946460400000057454250", "hex")],
  ];
  for (const [i, [mime, bytes]] of samples.entries()) {
    const data = structuredClone(input);
    data.assets = [data.assets[0], { id: "bad", p: `data:image/${mime};base64,${bytes.toString("base64")}` }];
    fs.writeFileSync(source, JSON.stringify(data));
    const imported = path.join(root, `bad-${i}.json`);
    runLottieImport([`--project=${project}`, "--scene=animation", "--append", `--source=${source}`, `--out=${imported}`]);
    expect(() => runLottieImport([`--project=${imported}`, "--scene=animation", `--save-assets=${library}`])).toThrow(/截断|解码/);
    expect(fs.readdirSync(library)).toEqual([]);
  }
});

it("rejects a locked scene and preflights later conflicts without publishing earlier assets", () => {
  const { source, project, root, jpg } = assetProject(); vi.spyOn(console, "log").mockImplementation(() => {});
  const imported = path.join(root, "imported.json"), library = path.join(root, "library"); fs.mkdirSync(library);
  runLottieImport([`--project=${project}`, "--scene=animation", "--append", `--source=${source}`, `--out=${imported}`]);
  const data = JSON.parse(fs.readFileSync(imported, "utf8")); data.scenes[1].locked = true; fs.writeFileSync(imported, JSON.stringify(data));
  expect(() => runLottieImport([`--project=${imported}`, "--scene=animation", `--save-assets=${library}`])).toThrow(/锁定/);
  const cli = fileURLToPath(new URL("./glint.ts", import.meta.url)), tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
  const env = { ...process.env, HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, TEMP: root, TMP: root };
  const locked = spawnSync(process.execPath, ["--import", tsx, cli, "lottie-import", `--project=${imported}`, "--scene=animation", `--save-assets=${library}`], { cwd: root, env, encoding: "utf8", timeout: 30000 });
  expect(locked.status).not.toBe(0); expect(locked.stderr + locked.stdout).toMatch(/锁定/);
  expect(fs.readdirSync(library)).toEqual([]);
  data.scenes[1].locked = false; fs.writeFileSync(imported, JSON.stringify(data));
  const name = `lottie-${createHash("sha256").update(jpg).digest("hex")}.jpg`;
  fs.writeFileSync(path.join(library, name), "foreign");
  expect(() => runLottieImport([`--project=${imported}`, "--scene=animation", `--save-assets=${library}`])).toThrow(/内容不一致/);
  expect(fs.readdirSync(library)).toEqual([name]); expect(fs.readFileSync(path.join(library, name), "utf8")).toBe("foreign");
});

it("reports published assets when a later destination appears after preflight", () => {
  const { source, project, root, jpg } = assetProject(); vi.spyOn(console, "log").mockImplementation(() => {});
  const imported = path.join(root, "imported.json"), library = path.join(root, "library"); fs.mkdirSync(library);
  runLottieImport([`--project=${project}`, "--scene=animation", "--append", `--source=${source}`, `--out=${imported}`]);
  const originalLink = fs.linkSync, conflict = path.join(library, `lottie-${createHash("sha256").update(jpg).digest("hex")}.jpg`);
  let links = 0;
  vi.spyOn(fs, "linkSync").mockImplementation((from, to) => {
    links++;
    if (links === 2) fs.writeFileSync(conflict, "foreign", { flag: "wx" });
    return originalLink(from, to);
  });
  let message = "";
  try { runLottieImport([`--project=${imported}`, "--scene=animation", `--save-assets=${library}`]); } catch (error) { message = String(error); }
  expect(message).toMatch(/部分回执/);
  const receipt = JSON.parse(message.split("部分回执 ")[1]!);
  expect(receipt.published).toHaveLength(1); expect(receipt.published[0].state).toBe("created");
  expect(fs.existsSync(path.join(library, receipt.published[0].file))).toBe(true);
  expect(fs.readFileSync(conflict, "utf8")).toBe("foreign");
  expect(fs.readdirSync(library).filter(name => name.endsWith(".part"))).toEqual([]);
});

it("restores assets from an edited product scene and verifies them against the library through the real CLI", () => {
  const { source, project, root } = assetProject();
  vi.spyOn(console, "log").mockImplementation(() => {});
  const imported = path.join(root, "imported.json");
  runLottieImport([`--project=${project}`, "--scene=animation", "--append", `--source=${source}`, `--out=${imported}`]);
  // 编辑产物：调参后的新工程同样是合法回库来源。
  const edited = path.join(root, "edited.json");
  runLottieImport([`--project=${imported}`, "--scene=animation", "--opacity=0.5", `--out=${edited}`]);
  const library = path.join(root, "library");
  fs.mkdirSync(library);
  const cli = fileURLToPath(new URL("./glint.ts", import.meta.url)), tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
  const env = { ...process.env, HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, TEMP: root, TMP: root };
  const result = spawnSync(process.execPath, ["--import", tsx, cli, "lottie-import", `--project=${edited}`, "--scene=animation", `--save-assets=${library}`], { cwd: root, env, encoding: "utf8", timeout: 30000 });
  expect(result.status, result.stderr).toBe(0);
  const receipt = JSON.parse(result.stdout);
  expect(receipt.saved).toHaveLength(3);
  const scene = parseProject(JSON.parse(fs.readFileSync(edited, "utf8"))).scenes[1]!;
  if (scene.kind !== "html") throw new Error("Expected html");
  expect(readImportedLottie(scene).settings).toMatchObject({ opacity: 0.5 });
  for (const entry of receipt.saved) {
    const stored = fs.readFileSync(path.join(library, entry.file));
    expect(createHash("sha256").update(stored).digest("hex")).toBe(entry.sha256);
  }
});
