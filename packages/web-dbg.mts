import { parseNleProject } from "./packages/scenescript/src/index.ts";
import { diffNleProjects } from "./apps/web/src/nle-session.ts";
const before = parseNleProject({ schemaVersion: 1, id: "k", title: "K", fps: 30, width: 1920, height: 1080, tracks: [{ id: "ov1", kind: "overlay", name: "叠加", clips: [{ id: "shot", kind: "text", text: "镜头", startMs: 0, durationMs: 6000 }] }] } as never);
const after = JSON.parse(JSON.stringify(before));
after.tracks[0].clips[0].keyframes = [{ ms: 2000, x: 0, y: 0, scale: 1, rotate: 0, opacity: 1 }];
try { console.log("diff:", JSON.stringify(diffNleProjects(before, after))); }
catch (e) { console.log("THROWN:", e.message); }
