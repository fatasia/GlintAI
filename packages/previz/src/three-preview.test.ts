import { expect, it } from "vitest";
import { PrevizDoc, exportCamera } from "./index";
import { threePreviewHtml } from "./three-preview";
const doc = PrevizDoc.parse({
  schemaVersion: 1,
  id: "test",
  title: "Geometry",
  aspect: "16:9",
  stage: { width: 10, depth: 10 },
  props: [],
  actors: [
    {
      id: "person",
      name: "</script><script>alert(1)</script>",
      heightM: 1.7,
      position: [0, 0, 0],
      pose: "stand",
    },
  ],
  cameras: [
    {
      id: "camera",
      name: "Camera",
      keys: [{ tMs: 0, position: [0, 2, 5], target: { point: [0, 1, 0] } }],
    },
  ],
  shots: [],
});
it("creates explicit standing proxy geometry without names, asset URLs or pose claims", () => {
  const camera = exportCamera(doc, "camera", 0),
    plain = threePreviewHtml(doc, camera, 0.1, 100, "rgb"),
    proxy = threePreviewHtml(doc, camera, 0.1, 100, "rgb", true);
  expect(plain).toContain('"props":[]');
  expect(proxy).toContain('"shape":"cylinder"');
  expect(proxy).toContain('"shape":"sphere"');
  expect(proxy).not.toContain("alert(1)");
  expect(proxy).not.toContain("https:");
  expect(threePreviewHtml(doc, camera, 0.1, 100, "rgb", true)).toBe(proxy);
});
it("does not invent other poses", () => {
  expect(() =>
    threePreviewHtml(
      { ...doc, actors: [{ ...doc.actors[0]!, pose: "dance" }] },
      exportCamera(doc, "camera", 0),
      0.1,
      100,
      "rgb",
      true,
    ),
  ).toThrow("standing");
});
