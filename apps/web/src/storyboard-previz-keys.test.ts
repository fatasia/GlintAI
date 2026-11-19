import { expect, it } from "vitest";
import { buildSeries } from "@glintai/composer/drama-series";
import { previzFromScene } from "@glintai/composer/drama-previz";
import { actorKeyEdit, cameraKeyEdit, migrateDraftCopy } from "./storyboard-previz-keys";
import { parsePrevizDraft, previzPreview } from "./storyboard-previz-model";
function fixture() {
  const series = buildSeries("第一场 茶馆 内 日\n老陈：新茶到了。", {
    id: "draft",
    title: "Tea",
    engine: "mg",
    aspect: "16:9",
  });
  return previzFromScene(series, series.episodes[0]!.scenes[0]!.id).doc;
}
it("adds, edits and removes camera keys without losing actor targets or source", () => {
  const source = fixture(),
    original = JSON.stringify(source),
    id = source.cameras[0]!.id;
  const added = cameraKeyEdit(source, id, { action: "add", tMs: 500 });
  expect(added.cameras[0]!.keys).toHaveLength(2);
  const key = added.cameras[0]!.keys[1]!;
  const changed = cameraKeyEdit(
    added,
    id,
    { action: "replace", index: 1 },
    {
      ...key,
      tMs: 800,
      easing: "ease-in-out",
      target: { actorId: source.actors[0]!.id, offset: [0, 1, 0] },
    },
  );
  expect(changed.cameras[0]!.keys[1]!.target).toEqual({
    actorId: source.actors[0]!.id,
    offset: [0, 1, 0],
  });
  expect(cameraKeyEdit(changed, id, { action: "remove", index: 1 })).toEqual(source);
  expect(JSON.stringify(source)).toBe(original);
  expect(() => cameraKeyEdit(source, id, { action: "add", tMs: 0 })).toThrow();
  expect(() => cameraKeyEdit(source, id, { action: "remove", index: 0 })).toThrow();
  expect(() => cameraKeyEdit(source, id, { action: "remove", index: -1 })).toThrow();
});
it("explicitly copies v1 into v2 and previews moving procedural poses deterministically", () => {
  const source = fixture(),
    original = JSON.stringify(source),
    actorId = source.actors[0]!.id;
  let doc = migrateDraftCopy(source, "action-copy");
  expect(doc.schemaVersion).toBe(2);
  expect(doc.id).not.toBe(source.id);
  expect(() => migrateDraftCopy(source, source.id)).toThrow();
  expect(() => actorKeyEdit(source, actorId, { action: "add", tMs: 0 })).toThrow("migrateFirst");
  doc = actorKeyEdit(doc, actorId, { action: "add", tMs: 0 });
  doc = actorKeyEdit(doc, actorId, { action: "add", tMs: 1000 });
  if (doc.schemaVersion !== 2) throw new Error("v2 required");
  const key = doc.actorTracks[0]!.keys[1]!;
  doc = actorKeyEdit(
    doc,
    actorId,
    { action: "replace", index: 1 },
    { ...key, pose: "sit", position: [2, 0, 0] },
  );
  expect(parsePrevizDraft(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
  expect(previzPreview(doc, doc.shots[0]!.id, 0).project).not.toEqual(
    previzPreview(doc, doc.shots[0]!.id, 12).project,
  );
  expect(JSON.stringify(source)).toBe(original);
  const removed = actorKeyEdit(
    actorKeyEdit(doc, actorId, { action: "remove", index: 1 }),
    actorId,
    { action: "remove", index: 0 },
  );
  expect(removed.schemaVersion === 2 && removed.actorTracks).toEqual([]);
});
it("rejects duplicate times, unbounded joint data and unsafe geometry without modifying the draft", () => {
  const source = fixture(),
    actorId = source.actors[0]!.id;
  const doc = actorKeyEdit(migrateDraftCopy(source, "copy"), actorId, { action: "add", tMs: 0 });
  const before = JSON.stringify(doc);
  expect(() => actorKeyEdit(doc, actorId, { action: "add", tMs: 0 })).toThrow();
  if (doc.schemaVersion !== 2) throw new Error("v2 required");
  const key = doc.actorTracks[0]!.keys[0]!;
  expect(() =>
    actorKeyEdit(
      doc,
      actorId,
      { action: "replace", index: 0 },
      {
        ...key,
        joints: [{ joint: "head", rotationDeg: [NaN, 0, 0] }],
      },
    ),
  ).toThrow();
  expect(() =>
    parsePrevizDraft({
      ...doc,
      props: [
        {
          id: "external",
          name: "External",
          shape: "model",
          assetId: "assets/a.glb",
          position: [0, 0, 0],
          size: [1, 1, 1],
        },
      ],
    }),
  ).toThrow("unsupported");
  expect(JSON.stringify(doc)).toBe(before);
});
