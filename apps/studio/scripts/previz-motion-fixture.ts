import { createPrevizDocument } from "../../../packages/previz/src/index";
export function animatedFixture() {
  const doc = createPrevizDocument("animated", "Procedural motion");
  doc.actorTracks = [
    {
      actorId: "actor",
      keys: [
        {
          tMs: 0,
          position: [-1, 0, 0],
          yawDeg: 0,
          pose: "walk",
          phase: 0,
          easing: "linear",
          joints: [],
        },
        {
          tMs: 1000,
          position: [1, 0, 0],
          yawDeg: 0,
          pose: "walk",
          phase: 1,
          easing: "linear",
          joints: [],
        },
      ],
    },
  ];
  return doc;
}
