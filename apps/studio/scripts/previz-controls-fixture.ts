export const fixture = () => ({
  schemaVersion: 1,
  id: "controls",
  title: "Primitives",
  aspect: "16:9",
  fps: 24,
  stage: { width: 10, depth: 10 },
  actors: [],
  props: [
    { id: "cube", name: "Cube", shape: "box", position: [0, 0, 0], size: [2, 2, 2], yawDeg: 20 },
  ],
  cameras: [
    {
      id: "camera",
      name: "Camera",
      fovDeg: 45,
      keys: [
        { tMs: 0, position: [4, 3, 6], target: { point: [0, 1, 0] }, easing: "linear" },
        { tMs: 1000, position: [-4, 3, 6], target: { point: [0, 1, 0] }, easing: "linear" },
      ],
    },
  ],
  shots: [{ id: "shot", cameraId: "camera", startMs: 2000, endMs: 4000, subjectIds: [] }],
});
