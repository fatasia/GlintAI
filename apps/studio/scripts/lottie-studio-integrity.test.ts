import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { parseProject } from "@glintai/scenescript";
import { inspectLottieScene, inspectLottieSource, readImportedLottie, runLottieImport, validateLottie } from "./lottie-import";
import { startLottieStudio } from "./lottie-studio";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-lottie-integrity-"));
  const examples = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../../../examples/local-media/readiness.scenescript.json", import.meta.url)), "utf8"));
  const scene = examples.scenes.find((item: { animation?: string }) => item.animation === "lottie");
  const animation = JSON.parse(scene.html.match(/window\.__glintLottie=([\s\S]*);<\/script>/)[1]);
  const project = path.join(root, "project.json"), source = path.join(root, "source.json");
  fs.writeFileSync(project, JSON.stringify({ schemaVersion: 1, id: "p", title: "原工程", aspect: "16:9", fps: 24, knowledgeSources: [], scenes: [{ id: "first", kind: "title", title: "Start", narration: { text: "Start", durationMs: 1000 } }] }));
  fs.writeFileSync(source, JSON.stringify(animation));
  return { root, project, source, animation };
}

it("writes the verified input snapshots even if both files change afterwards", () => {
  const f = fixture();
  try {
    const snapshot = { project: fs.readFileSync(f.project), source: fs.readFileSync(f.source) };
    fs.writeFileSync(f.project, JSON.stringify({ ...JSON.parse(snapshot.project.toString()), title: "未审阅" }));
    fs.writeFileSync(f.source, JSON.stringify({ ...f.animation, w: f.animation.w + 1 }));
    const out = path.join(f.root, "out.json");
    runLottieImport([`--project=${f.project}`, "--scene=motion", "--append", `--source=${f.source}`, `--out=${out}`], snapshot);
    const result = parseProject(JSON.parse(fs.readFileSync(out, "utf8")));
    expect(result.title).toBe("原工程");
    const scene = result.scenes.find(item => item.id === "motion")!;
    if (scene.kind !== "html") throw new Error("expected Lottie");
    expect(readImportedLottie(scene).source.w).toBe(f.animation.w);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

it("preserves UTF-8 characters split between HTTP chunks and rejects malformed UTF-8", async () => {
  const f = fixture(), studio = await startLottieStudio({ project: f.project, source: f.source, scene: "motion" });
  try {
    const url = new URL(studio.url), token = url.hash.slice(1), base = url.origin;
    const state = await (await fetch(`${base}/api/state`, { headers: { "x-glint-token": token } })).json() as { revision: string };
    const raw = Buffer.from(JSON.stringify({ revision: state.revision, output: "中文.json", edits: {} }));
    const split = raw.indexOf(Buffer.from("中")) + 1;
    const post = (chunks: Buffer[]) => new Promise<number>((resolve, reject) => {
      const req = http.request(`${base}/api/save`, { method: "POST", headers: { "x-glint-token": token, "content-type": "application/json" } }, res => { res.resume(); res.on("end", () => resolve(res.statusCode!)); });
      req.on("error", reject); req.write(chunks[0]); setTimeout(() => req.end(chunks[1]), 10);
    });
    expect(await post([raw.subarray(0, split), raw.subarray(split)])).toBe(200);
    expect(fs.existsSync(path.join(f.root, "中文.json"))).toBe(true);
    const invalid = Buffer.concat([Buffer.from('{"output":"'), Buffer.from([0xff]), Buffer.from('"}')]);
    expect(await post([invalid.subarray(0, 12), invalid.subarray(12)])).toBe(400);
  } finally { await studio.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

it("rejects malformed UTF-8 in direct source and project reads without writing output", () => {
  const f = fixture();
  try {
    const badSource = Buffer.from(JSON.stringify(f.animation).replace('"layers"', '"bad":"X","layers"'));
    badSource[badSource.indexOf(Buffer.from('"X"')) + 1] = 0xff;
    fs.writeFileSync(f.source, badSource);
    expect(() => inspectLottieSource(f.source)).toThrow();
    expect(() => runLottieImport([`--project=${f.project}`, "--scene=motion", "--append", `--source=${f.source}`, `--out=${path.join(f.root, "out.json")}`])).toThrow();
    expect(fs.existsSync(path.join(f.root, "out.json"))).toBe(false);
    const badProject = Buffer.from(fs.readFileSync(f.project));
    badProject[badProject.indexOf(Buffer.from("原"))] = 0xff;
    fs.writeFileSync(f.project, badProject);
    expect(() => inspectLottieScene(f.project, "first")).toThrow();
    expect(() => runLottieImport([`--project=${f.project}`, "--scene=first"])).toThrow();
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

it("rejects non-string external font paths", () => {
  const f = fixture();
  try {
    for (const fPath of [["https://example.invalid/font.css"], { href: "https://example.invalid" }, "https://example.invalid/font.css"]) {
      expect(() => validateLottie({ ...f.animation, fonts: { list: [{ fOrigin: "g", fPath }] } })).toThrow(/外部字体路径/);
    }
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
