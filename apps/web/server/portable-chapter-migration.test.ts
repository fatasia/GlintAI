import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseProject } from "../../../packages/scenescript/src/parse";
import { exportPortableChapters, importPortableChapters, preflightPortableChapters } from "./portable-chapter-migration";
import { createPortableImportController } from "../src/portable-chapter-import";
import { CHAPTERS_KEY } from "../src/ChaptersStore";

let root: string;
let png: Buffer;
const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const project = (id: string, ref = "assets/hero.png") => parseProject({ schemaVersion: 1, id, title: id, aspect: "16:9", knowledgeSources: [], scenes: [{ id: "one", kind: "image", src: ref, narration: { text: "正文", durationMs: 1000 } }] });
const snap = (id: string, ref?: string) => ({ title: `章节 ${id}`, updatedAt: 123, context: { mode: "source" as const, text: "资料", template: "explainer", theme: "whiteboard", evidence: "证据" }, project: project(id, ref) });
const data = (snapshots = [snap("one"), snap("two")]) => exportPortableChapters(snapshots, () => png);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-migration-test-"));
  const image = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=16x16", "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "pipe:1"], { maxBuffer: 1024 * 1024, windowsHide: true });
  if (image.status !== 0) throw new Error(`fixture creation failed: ${image.stderr}`);
  png = image.stdout;
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

describe("portable chapter migration", () => {
  it.skipIf(process.platform !== "win32")("demonstrates that a Windows junction swap after realpath redirects publication", async () => {
    const bundle = await data([snap("one")]);
    const library = path.join(root, "library"), parked = path.join(root, "parked"), outside = path.join(root, "outside");
    fs.mkdirSync(library); fs.mkdirSync(outside);
    const open = fs.promises.open.bind(fs.promises);
    let swapped = false;
    const spy = vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
      if (!swapped && String(args[0]).includes(".chapter-incoming-")) {
        swapped = true;
        fs.renameSync(library, parked);
        fs.symlinkSync(outside, library, "junction");
      }
      return open(...args);
    });
    try {
      await importPortableChapters(bundle, library);
      expect(swapped).toBe(true);
      expect(fs.readdirSync(parked)).toEqual([]);
      expect(fs.readFileSync(path.join(outside, `chapter-${digest(png)}.png`))).toEqual(png);
    } finally {
      spy.mockRestore();
      if (swapped) fs.unlinkSync(library);
    }
  }, 30000);

  it("exports and restores complete ordered snapshots and deduplicates assets", async () => {
    const snapshots = [snap("one"), snap("two")], bundle = await data(snapshots);
    const result = await importPortableChapters(bundle, root);
    expect(result.importId).toBe(digest(Buffer.from(bundle)));
    expect(result.chapters.map(c => [c.title, c.updatedAt, c.context])).toEqual(snapshots.map(c => [c.title, c.updatedAt, c.context]));
    const name = `chapter-${digest(png)}.png`;
    expect(result.chapters.map(c => (c.project.scenes[0] as { src: string }).src)).toEqual([`assets/${name}`, `assets/${name}`]);
    expect(fs.readFileSync(path.join(root, name))).toEqual(png);
    expect(await importPortableChapters(bundle, root)).toEqual(result);
    expect(fs.readdirSync(root)).toEqual([name]);
  });

  it.each(["deleted", "replaced"])("revalidates actual %s media after local storage fails", async scenario => {
    const bundle = await data([snap("one")]);
    const records = new Map<string, string>(); let fail = true;
    const storage = { getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => { if (fail) throw new Error("quota"); records.set(key, value); } };
    let publications = 0;
    const controller = createPortableImportController({
      preflight: async input => (await preflightPortableChapters(input, root)).chapters,
      publish: async input => { publications++; return (await importPortableChapters(input, root)).chapters; },
    }, storage, async task => task());
    const preview = await controller.preflight(bundle);
    expect(fs.readdirSync(root)).toEqual([]);
    await expect(controller.confirm(preview.token)).rejects.toThrow(/保存失败/);
    const asset = path.join(root, `chapter-${digest(png)}.png`);
    expect(fs.readFileSync(asset)).toEqual(png);
    expect(storage.getItem(CHAPTERS_KEY)).toBeNull();
    fail = false;
    if (scenario === "deleted") {
      fs.unlinkSync(asset);
      await controller.confirm(preview.token);
      expect(fs.readFileSync(asset)).toEqual(png);
      expect(JSON.parse(storage.getItem(CHAPTERS_KEY)!).chapters).toHaveLength(1);
    } else {
      fs.writeFileSync(asset, "foreign");
      await expect(controller.confirm(preview.token)).rejects.toThrow(/冲突/);
      expect(fs.readFileSync(asset, "utf8")).toBe("foreign");
      expect(storage.getItem(CHAPTERS_KEY)).toBeNull();
      expect(controller.retainedPackage()).toBe(bundle);
    }
    expect(publications).toBe(2);
  }, 30000);

  it("rewrites media fields without changing equal user-authored text", async () => {
    const original = snap("one");
    original.project.title = "assets/hero.png";
    original.project.scenes[0]!.narration.text = "assets/hero.png";
    original.project.scenes[0]!.notes = "assets/hero.png";
    const bundle = await exportPortableChapters([original], () => png);
    const result = await importPortableChapters(bundle, root);
    const restored = result.chapters[0]!.project;
    expect(restored.title).toBe("assets/hero.png");
    expect(restored.scenes[0]!.narration.text).toBe("assets/hero.png");
    expect(restored.scenes[0]!.notes).toBe("assets/hero.png");
    expect((restored.scenes[0] as { src: string }).src).toBe(`assets/chapter-${digest(png)}.png`);
    const second = await exportPortableChapters(result.chapters, name => fs.readFileSync(path.join(root, name)));
    const again = await importPortableChapters(second, root);
    expect(again.chapters).toEqual(result.chapters);
  });

  it("refuses malformed, tampered, invalid base64 and late corrupt assets before writes", async () => {
    const bundle = JSON.parse(await data());
    const cases = [
      (x: typeof bundle) => { x.chapters[1].assets[0].data += "!"; },
      (x: typeof bundle) => { x.chapters[1].assets[0].sha256 = "0".repeat(64); },
      (x: typeof bundle) => { x.chapters[1].assets[0].bytes++; },
      (x: typeof bundle) => { x.chapters[1].assets = []; },
      (x: typeof bundle) => { x.version = 1; },
      (x: typeof bundle) => { x.chapters[1].snapshot.project.extraData = "must not be lost"; },
    ];
    for (const change of cases) {
      const bad = structuredClone(bundle); change(bad);
      await expect(importPortableChapters(JSON.stringify(bad), root)).rejects.toThrow();
      expect(fs.readdirSync(root)).toEqual([]);
    }
  });

  it("rejects signature-only truncated media even with matching size and hash", async () => {
    const bundle = JSON.parse(await data());
    const broken = png.subarray(0, 32);
    for (const chapter of bundle.chapters) Object.assign(chapter.assets[0], { data: broken.toString("base64"), sha256: digest(broken), bytes: broken.length });
    await expect(importPortableChapters(JSON.stringify(bundle), root)).rejects.toThrow(/探测失败|解码|尺寸/);
    expect(fs.readdirSync(root)).toEqual([]);
    await expect(exportPortableChapters([snap("bad")], () => broken)).rejects.toThrow(/探测失败|解码|尺寸/);
  });

  it("rejects content-address conflicts without overwriting and preflights all files", async () => {
    const second = Buffer.from(png); // Change compressed bytes but preserve a decodable distinct image via metadata.
    const generated = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=16x16", "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "pipe:1"], { windowsHide: true });
    expect(generated.status).toBe(0);
    const blue = generated.stdout;
    const bundle = await exportPortableChapters([snap("one"), snap("two", "assets/blue.png")], name => name === "hero.png" ? second : blue);
    const conflict = path.join(root, `chapter-${digest(blue)}.png`);
    fs.writeFileSync(conflict, "user file");
    await expect(importPortableChapters(bundle, root)).rejects.toThrow(/冲突/);
    expect(fs.readFileSync(conflict, "utf8")).toBe("user file");
    expect(fs.readdirSync(root)).toHaveLength(1);
  });

  it("recovers after a late publication error without deleting an already published asset", async () => {
    const generated = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=16x16", "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "pipe:1"], { windowsHide: true });
    const blue = generated.stdout;
    const bundle = await exportPortableChapters([snap("one"), snap("two", "assets/blue.png")], name => name === "hero.png" ? png : blue);
    const link = fs.promises.link.bind(fs.promises); let calls = 0;
    const spy = vi.spyOn(fs.promises, "link").mockImplementation(async (source, destination) => { if (++calls === 2) throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); return link(source, destination); });
    await expect(importPortableChapters(bundle, root)).rejects.toThrow(/disk full/);
    expect(fs.readdirSync(root)).toEqual([`chapter-${digest(png)}.png`]);
    spy.mockRestore();
    expect((await importPortableChapters(bundle, root)).chapters).toHaveLength(2);
    expect(fs.readdirSync(root).sort()).toEqual([`chapter-${digest(png)}.png`, `chapter-${digest(blue)}.png`].sort());
  });

  it("accepts a competing identical publish and rejects a competing different file", async () => {
    const bundle = await data();
    const link = fs.promises.link.bind(fs.promises);
    const spy = vi.spyOn(fs.promises, "link").mockImplementation(async (source, destination) => { await link(source, destination); throw Object.assign(new Error("raced"), { code: "EEXIST" }); });
    expect((await importPortableChapters(bundle, root)).chapters).toHaveLength(2);
    spy.mockRestore();
    fs.unlinkSync(path.join(root, `chapter-${digest(png)}.png`));
    vi.spyOn(fs.promises, "link").mockImplementation(async (_source, destination) => { await fs.promises.writeFile(destination, "foreign", { flag: "wx" }); throw Object.assign(new Error("raced"), { code: "EEXIST" }); });
    await expect(importPortableChapters(bundle, root)).rejects.toThrow(/冲突/);
    expect(fs.readFileSync(path.join(root, `chapter-${digest(png)}.png`), "utf8")).toBe("foreign");
  });

  it("leaves published bytes intact when cancelled between assets and resumes safely", async () => {
    const generated = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=16x16", "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "pipe:1"], { windowsHide: true });
    expect(generated.status).toBe(0);
    const blue = generated.stdout;
    const bundle = await exportPortableChapters([snap("one"), snap("two", "assets/blue.png")], name => name === "hero.png" ? png : blue);
    const controller = new AbortController(), link = fs.promises.link.bind(fs.promises);
    const spy = vi.spyOn(fs.promises, "link").mockImplementation(async (source, destination) => { await link(source, destination); controller.abort(); });
    await expect(importPortableChapters(bundle, root, controller.signal)).rejects.toThrow();
    expect(fs.readdirSync(root)).toEqual([`chapter-${digest(png)}.png`]);
    spy.mockRestore();
    expect((await importPortableChapters(bundle, root)).chapters).toHaveLength(2);
    expect(fs.readdirSync(root)).toHaveLength(2);
  });

  it("allows two independent processes to import the same package concurrently", async () => {
    const bundleFile = path.join(root, "input.json"), library = path.join(root, "library");
    fs.mkdirSync(library); fs.writeFileSync(bundleFile, await data());
    const moduleUrl = new URL("./portable-chapter-migration.ts", import.meta.url).href;
    const script = `import fs from 'node:fs'; import {importPortableChapters} from ${JSON.stringify(moduleUrl)}; const r=await importPortableChapters(fs.readFileSync(process.argv[1],'utf8'),process.argv[2]); console.log(r.importId);`;
    const run = () => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, bundleFile, library], { windowsHide: true, cwd: path.resolve(process.cwd(), "apps/web") });
      let output = ""; child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
      child.on("error", reject); child.on("close", code => resolve({ code, output }));
    });
    const [first, second] = await Promise.all([run(), run()]);
    expect(first.code, first.output).toBe(0); expect(second.code, second.output).toBe(0);
    expect(first.output.trim()).toBe(second.output.trim());
    expect(fs.readdirSync(library)).toEqual([`chapter-${digest(png)}.png`]);
  }, 30000);

  it("cancels during decoding without publishing and leaves the event loop responsive", async () => {
    const bundle = await data();
    const controller = new AbortController();
    let timerRan = false;
    const operation = importPortableChapters(bundle, root, controller.signal);
    const timer = setTimeout(() => { timerRan = true; controller.abort(new Error("测试取消")); }, 10);
    await expect(operation).rejects.toThrow("测试取消");
    clearTimeout(timer);
    expect(timerRan).toBe(true);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("keeps publication asynchronous and checks cancellation before linking", async () => {
    const bundle = await data();
    const controller = new AbortController();
    const open = fs.promises.open.bind(fs.promises);
    let reached!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { reached = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const spy = vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
      if (String(args[0]).includes(".chapter-incoming-")) { reached(); await gate; }
      return open(...args);
    });
    const operation = importPortableChapters(bundle, root, controller.signal);
    const assertion = expect(operation).rejects.toThrow("取消发布");
    try {
      await entered;
      let timerRan = false;
      await new Promise<void>(resolve => setTimeout(() => { timerRan = true; resolve(); }, 0));
      expect(timerRan).toBe(true);
      controller.abort(new Error("取消发布"));
    } finally { release(); }
    await assertion;
    spy.mockRestore();
    expect(fs.readdirSync(root)).toEqual([]);
    expect((await importPortableChapters(bundle, root)).chapters).toHaveLength(2);
  });

  it("terminates an active decoder when the package deadline expires", async () => {
    const bundle = await data();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const operation = importPortableChapters(bundle, root);
      const assertion = expect(operation).rejects.toThrow(/整包处理时限/);
      await vi.advanceTimersByTimeAsync(30_000);
      await assertion;
      expect(fs.readdirSync(root)).toEqual([]);
    } finally { vi.useRealTimers(); }
  });

  it("uses one deadline from the beginning of the entire export", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const snapshots = [snap("one"), snap("two", "assets/blue.png")];
    await expect(exportPortableChapters(snapshots, () => { now += 16_000; return png; })).rejects.toThrow(/整包处理时限/);
  });

  it("fails closed if the decoder is unavailable", async () => {
    const bundle = await data();
    const original = process.env.PATH;
    try {
      process.env.PATH = root;
      await expect(importPortableChapters(bundle, root)).rejects.toThrow();
      expect(fs.readdirSync(root)).toEqual([]);
    } finally { process.env.PATH = original; }
  });

  it("honors cancellation before writes and rejects unsafe source references", async () => {
    const bundle = await data(); const controller = new AbortController(); controller.abort();
    await expect(importPortableChapters(bundle, root, controller.signal)).rejects.toThrow();
    expect(fs.readdirSync(root)).toEqual([]);
    const unsafe = snap("bad"); (unsafe.project.scenes[0] as { src: string }).src = "assets/../secret.png";
    await expect(exportPortableChapters([unsafe], () => png)).rejects.toThrow(/不安全的资源路径/);
  });
});
