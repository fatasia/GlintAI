import { expect, it } from "vitest";
import { buildSeries } from "@glintai/composer/drama-series";
import { previzFromScene } from "@glintai/composer/drama-previz";
import {
  editPreviz,
  parsePrevizDraft,
  previzPreview,
  readPrevizFile,
} from "./storyboard-previz-model";
const initial = () => {
  const series = buildSeries("第一场 茶馆 内 日\n老陈：新茶到了。\n小满：好。", {
    id: "draft",
    title: "Tea",
    engine: "mg",
    aspect: "16:9",
  });
  return previzFromScene(series, series.episodes[0]!.scenes[0]!.id).doc;
};
it("edits a selected camera and actor without changing the source document", () => {
  const doc = initial(),
    before = JSON.stringify(doc),
    camera = doc.cameras[0]!,
    actor = doc.actors[0]!;
  const moved = editPreviz(doc, "camera", camera.id, "x", "4");
  expect(moved.cameras[0]!.keys[0]!.position[0]).toBe(4);
  expect(moved.actors).toEqual(doc.actors);
  const positioned = editPreviz(moved, "actor", actor.id, "yaw", "90");
  expect(positioned.actors[0]!.yawDeg).toBe(90);
  expect(JSON.stringify(doc)).toBe(before);
  expect(parsePrevizDraft(JSON.parse(JSON.stringify(positioned)))).toEqual(positioned);
  expect(previzPreview(moved, doc.shots[0]!.id, 0).project).not.toEqual(
    previzPreview(doc, doc.shots[0]!.id, 0).project,
  );
});
it("rejects invalid parameters, unknown data, resource models and unsupported poses", () => {
  const doc = initial(),
    camera = doc.cameras[0]!;
  for (const value of ["", "NaN", "Infinity", "121", "0"])
    expect(() => editPreviz(doc, "camera", camera.id, "fov", value)).toThrow();
  expect(() => parsePrevizDraft({ ...doc, html: "<script>bad()</script>" })).toThrow(
    "unknownFields",
  );
  const pose = structuredClone(doc);
  pose.actors[0]!.pose = "run";
  expect(() => parsePrevizDraft(pose)).toThrow("unsupported");
  expect(() =>
    parsePrevizDraft({
      ...doc,
      props: [
        {
          id: "model",
          name: "Model",
          shape: "model",
          assetId: "https://private.invalid",
          position: [0, 0, 0],
          size: [1, 1, 1],
        },
      ],
    }),
  ).toThrow("unsupported");
  expect(() => parsePrevizDraft({ ...doc, shots: [] })).toThrow("noShot");
});
it("rejects oversized/wrong-type files and preserves exact validated JSON", async () => {
  const doc = initial();
  expect(JSON.stringify(await readPrevizFile(new File([JSON.stringify(doc)], "test.json")))).toBe(
    JSON.stringify(doc),
  );
  await expect(readPrevizFile(new File(["{}"], "test.txt"))).rejects.toThrow("invalidFile");
  await expect(
    readPrevizFile(new File([new Uint8Array(2 * 1024 * 1024 + 1)], "large.json")),
  ).rejects.toThrow("invalidFile");
  await expect(readPrevizFile(new File(["{"], "bad.json"))).rejects.toThrow("invalidDocument");
});
