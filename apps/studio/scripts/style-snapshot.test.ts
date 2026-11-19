import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Resvg } from "@resvg/resvg-js";
import { expect, it } from "vitest";
import { resolveTheme, themes, THEME_NAMES } from "@glintai/design-tokens";
import { parseProject } from "@glintai/scenescript";
import { FileSessionStore } from "@glintai/session/node";
import { captureStyleTokens, readStyleSnapshot } from "../../web/src/style-snapshot";
import { renderSceneSvg } from "./native-svg";

const project = (theme: unknown) => parseProject({ schemaVersion: 1, id: "style-freeze", title: "Style", aspect: "16:9", fps: 30, knowledgeSources: [], theme, scenes: [{ id: "one", kind: "title", title: "标题", narration: { text: "旁白", durationMs: 1000 } }] });
const pixels = (p: ReturnType<typeof project>) => createHash("sha256").update(new Resvg(renderSceneSvg(p, p.scenes[0]!, 15, { width: 320, height: 180 }), { font: { loadSystemFonts: false } }).render().asPng()).digest("hex");

it("captures all existing themes as full independent tokens and preserves old named projects", () => {
  for (const name of THEME_NAMES) {
    const snapshot = captureStyleTokens(name), current = themes[name];
    expect(readStyleSnapshot(snapshot)).toMatchObject({ name, version: "1.0.0", modified: false });
    expect(resolveTheme(snapshot)).toEqual(current);
    expect(project(snapshot).theme).toEqual(snapshot);
    expect(project(name).theme).toBe(name);
  }
  expect(readStyleSnapshot({ colors: { bg: "#ffffff" } })).toBeUndefined();
  expect(readStyleSnapshot({ glintStyleSnapshot: { name: "unknown", version: "1.0.0", captured: {} } })).toBeUndefined();
});

it("interprets only intact v1 metadata without using mutable catalog defaults", () => {
  const original = captureStyleTokens("glint-light") as Record<string, any>;
  const saved = JSON.parse(JSON.stringify(original));
  const unknownVersion = structuredClone(saved); unknownVersion.glintStyleSnapshot.version = "2.0.0";
  expect(readStyleSnapshot(unknownVersion)).toBeUndefined();
  expect(unknownVersion.glintStyleSnapshot.captured).toEqual(saved.glintStyleSnapshot.captured);
  const badCapture = structuredClone(saved); delete badCapture.glintStyleSnapshot.captured.colors.bg;
  expect(readStyleSnapshot(badCapture)).toBeUndefined();
  const badType = structuredClone(saved); badType.glintStyleSnapshot.captured.radius = "large";
  expect(readStyleSnapshot(badType)).toBeUndefined();
  const missingCurrent = structuredClone(saved); delete missingCurrent.colors.bg;
  expect(readStyleSnapshot(missingCurrent)?.modified).toBe(true);
  const edited = structuredClone(saved); edited.fontSizes.h1++;
  expect(readStyleSnapshot(edited)?.modified).toBe(true);
  const withFutureField = structuredClone(saved); withFutureField.colors.future = "new";
  expect(readStyleSnapshot(withFutureField)?.modified).toBe(false);
  const base = themes["glint-dark"].colors as unknown as Record<string, unknown>;
  try {
    base.future = "catalog addition";
    expect(readStyleSnapshot(saved)?.modified).toBe(false);
  } finally { delete base.future; }
});

it("keeps persisted snapshot pixels after a catalog change, tracks edits and survives undo/redo", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glint-style-freeze-"));
  const name = "bold-poster", originalBg = themes[name].colors.bg;
  try {
    const legacy = project(name), captured = captureStyleTokens(name), frozen = project(captured), before = pixels(frozen);
    const store = new FileSessionStore(dir, value => { parseProject(value); }); store.open(frozen.id, legacy);
    const result = store.apply(frozen.id, { id: "freeze", projectId: frozen.id, baseRevision: 0, actor: "user", scope: {}, operations: [{ kind: "set", path: ["theme"], value: captured }], intent: "固定风格参数" });
    expect(result.receipt.stage).toBe("verified");
    const restored = project(new FileSessionStore(dir).snapshot(frozen.id).snapshot.document.theme);
    expect(restored.theme).toEqual(captured); expect(readStyleSnapshot(restored.theme)?.modified).toBe(false);
    themes[name].colors.bg = "#00ff00";
    expect(pixels(restored)).toBe(before); expect(pixels(project(name))).not.toBe(before);
    expect(resolveTheme(restored.theme).colors.bg).toBe(originalBg);
    const changed = structuredClone(restored.theme) as Record<string, any>; changed.colors.bg = "#ff0000";
    expect(readStyleSnapshot(changed)?.modified).toBe(true);
    store.historyEdit(frozen.id, "undo", "undo-style", 1, "user");
    expect(store.snapshot(frozen.id).snapshot.document.theme).toBe(name);
    store.historyEdit(frozen.id, "redo", "redo-style", 2, "user");
    expect(store.snapshot(frozen.id).snapshot.document.theme).toEqual(captured);
  } finally { themes[name].colors.bg = originalBg; fs.rmSync(dir, { recursive: true, force: true }); }
});
