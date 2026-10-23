import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { parseProject } from "@glintai/scenescript";
import { exportDeck, safeJson } from "./index";
import { resolveMediaPath } from "../native-process";

const make = (extra: object = {}) => parseProject({ schemaVersion: 1, id: "deck-test", title: '</title><script>bad()</script>', aspect: "16:9", knowledgeSources: [], scenes: [{ id: "intro", kind: "title", title: "开始", narration: { text: "讲解内容" }, notes: "备注", ...extra }] });
const fixture = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-deck-test-")); return { root, out: path.join(root, "output") }; };

describe("offline deck exporter", () => {
  it("exports all scene files and standalone working script without build helpers", async () => {
    const f = fixture();
    try {
      const result = await exportDeck({ project: make(), projectDir: f.root, outDir: f.out });
      const html = fs.readFileSync(result.indexPath, "utf8");
      expect(html).toContain("演讲者视图"); expect(html).toContain("&lt;/title&gt;");
      expect(html).not.toContain("__name(");
      const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
      expect(scripts).toHaveLength(2);
      for (const script of scripts) expect(() => new vm.Script(script[1]!)).not.toThrow();
      expect(fs.existsSync(path.join(f.out, "scenes", "intro.svg"))).toBe(true);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
  it("refuses overwriting an existing export", async () => {
    const f = fixture();
    try { fs.mkdirSync(f.out); await expect(exportDeck({ project: make(), projectDir: f.root, outDir: f.out })).rejects.toThrow("already exists"); }
    finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
  it("rejects missing audio before writing output", async () => {
    const f = fixture();
    try {
      await expect(exportDeck({ project: make({ narration: { text: "旁白", audioRef: "audio/missing.wav" } }), projectDir: f.root, outDir: f.out })).rejects.toThrow();
      expect(fs.existsSync(f.out)).toBe(false);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
  it("rejects unsupported HTML scenes before writing output", async () => {
    const f = fixture();
    try { await expect(exportDeck({ project: make({ kind: "html", html: "<b>test</b>" }), projectDir: f.root, outDir: f.out })).rejects.toThrow("browser backend"); expect(fs.existsSync(f.out)).toBe(false); }
    finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
  it.each(["../secret.wav", "/secret.wav", "C:/secret.wav", "audio/../secret.wav", "audio\\secret.wav", "audio//secret.wav"])("blocks unsafe media path %s", relative => {
    const f = fixture();
    try { expect(() => resolveMediaPath(f.root, relative)).toThrow(); }
    finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
  it("embeds data without script termination or Unicode parser hazards", () => {
    const value = { text: "</script><script>alert(1)</script>\u2028\u2029" };
    const safe = safeJson(value);
    expect(safe).not.toContain("</script>"); expect(JSON.parse(safe)).toEqual(value);
  });
  it("copies local audio bytes into a portable directory", async () => {
    const f = fixture();
    try {
      fs.mkdirSync(path.join(f.root, "audio")); fs.writeFileSync(path.join(f.root, "audio", "voice.wav"), "test-bytes");
      await exportDeck({ project: make({ narration: { text: "旁白", audioRef: "audio/voice.wav" } }), projectDir: f.root, outDir: f.out });
      expect(fs.readFileSync(path.join(f.out, "audio", "intro.wav"), "utf8")).toBe("test-bytes");
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
});
