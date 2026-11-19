import { describe, expect, it } from "vitest";
import { buildTimeline, evaluateElements, parseProject, timelineToFrames } from "@glintai/scenescript";
import { instantiateCreationPack, listCreationPacks } from "./creation-packs";
import { SHOWCASE_BEATS, SHOWCASE_BPM, SHOWCASE_FPS, showcaseBeatMs } from "./beat-showcase";

const make = () => instantiateCreationPack("beat-showcase", {}, { projectId: "showcase-test" }).project;

describe("beat showcase", () => {
  it("is searchable and deterministic, without external assets or providers", () => {
    expect(listCreationPacks("节拍").map(pack => pack.id)).toEqual(["beat-showcase"]);
    expect(make()).toEqual(make());
    expect(make().scenes.map(scene => scene.kind)).toEqual(["title", "bullets", "title", "code", "title", "bullets"]);
    expect(JSON.stringify(make())).not.toMatch(/audioRef|https?:|beatPulse|overlapMs/);
  });

  it.each(["16:9", "9:16", "1:1"] as const)("materializes editable %s text and tracks", aspect => {
    const project = instantiateCreationPack("beat-showcase", { title: "我的开场", code: "const answer = 42;" }, { projectId: "showcase-test", aspect }).project;
    expect(parseProject(project)).toEqual(project);
    expect(project.aspect).toBe(aspect);
    expect(project.scenes[0]).toMatchObject({ title: "我的开场" });
    expect(project.scenes[3]).toMatchObject({ code: "const answer = 42;" });
    const changed = structuredClone(project);
    if (changed.scenes[0]!.kind === "title") changed.scenes[0]!.title = "单独改字";
    expect(parseProject(changed).scenes.slice(1)).toEqual(project.scenes.slice(1));
    expect(changed.scenes[0]!.tracks).toEqual(project.scenes[0]!.tracks);
  });

  it("quantizes cumulative beats to frames without scene drift or overlap", () => {
    const project = make(), timeline = buildTimeline(project), frames = timelineToFrames(timeline, SHOWCASE_FPS);
    expect(project.fps).toBe(30);
    expect(frames.durationInFrames).toBe(514);
    expect(timeline.totalMs).toBe(17133);
    for (let beat = 0; beat <= SHOWCASE_BEATS; beat++) {
      expect(Math.round(showcaseBeatMs(beat) * SHOWCASE_FPS / 1000)).toBe(Math.round(beat * 60 * SHOWCASE_FPS / SHOWCASE_BPM));
    }
    timeline.entries.forEach((entry, index) => {
      expect(entry.startMs).toBe(showcaseBeatMs(index * 4));
      expect(entry.startMs + entry.durationMs).toBe(showcaseBeatMs((index + 1) * 4));
      expect(frames.entries[index]!.from).toBe(Math.round(index * 4 * 60 * SHOWCASE_FPS / SHOWCASE_BPM));
      expect(entry.scene.transition).toBeUndefined();
    });
  });

  it("samples editable pulse keys on the same global beat grid", () => {
    make().scenes.forEach((scene, index) => {
      const track = scene.tracks![0]!;
      for (let beat = 0; beat < 4; beat++) {
        const local = showcaseBeatMs(index * 4 + beat) - showcaseBeatMs(index * 4);
        expect(track.keyframes[beat * 2]!.atMs).toBe(local);
        expect(evaluateElements(scene, local)[0]!.scale).toBe(1.12);
        expect(evaluateElements(scene, local + 200)[0]!.scale).toBe(1);
      }
      expect(track.keyframes.at(-1)!.atMs).toBeLessThan(scene.narration.durationMs!);
    });
  });
});
