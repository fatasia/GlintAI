import { describe, expect, it } from "vitest";
import { parseProject } from "@glintai/scenescript";
import { repairPresentation } from "./presentation-repair";

const make = (extra: object[] = []) => parseProject({ schemaVersion: 1, id: "repair", title: "测试", aspect: "16:9", knowledgeSources: [], scenes: [0, 1, 2, 3].map(i => ({ id: `s${i}`, kind: "bullets", items: ["事实内容"], narration: { text: "不得改写的旁白", durationMs: 1000 }, camera: { type: "push" }, transition: { in: "flash" }, ...extra[i] })) });

describe("bounded presentation repair", () => {
  it("repairs camera repetition and accent budget without changing content", () => {
    const input = make(), result = repairPresentation(input);
    expect(result.verdict).not.toBe("red");
    expect(result.project.scenes.filter(s => s.transition?.in === "flash")).toHaveLength(2);
    expect(result.project.scenes.map(s => s.narration)).toEqual(input.scenes.map(s => s.narration));
    expect(input.scenes[2]!.camera!.type).toBe("push"); expect(result.changes.length).toBeGreaterThan(0);
  });
  it("downgrades unmatchable magic move explicitly and records the diff", () => {
    const result = repairPresentation(make([{ transition: { in: "magic-move" } }]));
    expect(result.project.scenes[0]!.transition!.in).toBe("fade");
    expect(result.changes.some(c => c.reason === "missing-shared-element")).toBe(true);
  });
  it("does not silently delete unknown sound cues to pass checks", () => {
    const input = make(); input.sfx = [{ sceneId: "missing", effect: "click" }];
    const result = repairPresentation(input); expect(result.verdict).toBe("red"); expect(result.project.sfx).toEqual(input.sfx);
  });
});
