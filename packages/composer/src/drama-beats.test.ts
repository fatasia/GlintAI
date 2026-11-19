import { describe, expect, it } from "vitest";
import { splitScreenplay } from "./drama";

describe("screenplay beats", () => {
  it("keeps every action block and the script order of action and dialogue", () => {
    const { episodes } = splitScreenplay("第1场 茶馆 内 日\n老周推门进来，抖落肩上的雪。\n老周：好冷的天。\n小林低头擦杯子，没有抬眼。\n小林：客官里面请。\n");
    const scene = episodes[0]!.scenes[0]!;
    expect(scene.action).toBe("老周推门进来，抖落肩上的雪。\n小林低头擦杯子，没有抬眼。");
    expect(scene.beats).toEqual([
      { kind: "action", text: "老周推门进来，抖落肩上的雪。" },
      { kind: "dialogue", character: "老周", line: "好冷的天。" },
      { kind: "action", text: "小林低头擦杯子，没有抬眼。" },
      { kind: "dialogue", character: "小林", line: "客官里面请。" },
    ]);
  });

  it("keeps action that trails the last line of dialogue", () => {
    const { episodes } = splitScreenplay("第1场 码头 外 夜\n阿海：船要开了。\n汽笛长鸣，灯塔转向远处。\n");
    const scene = episodes[0]!.scenes[0]!;
    expect(scene.beats?.map(beat => beat.kind)).toEqual(["dialogue", "action"]);
    expect(scene.action).toBe("汽笛长鸣，灯塔转向远处。");
  });

  it("does not turn the cue line of a bare character name into action as well", () => {
    const { episodes } = splitScreenplay("第1场 茶馆 内 日\n阿海：先来壶茶。\n阿海\n再加一碟花生。\n门外下起了雨。\n");
    const scene = episodes[0]!.scenes[0]!;
    expect(scene.dialogue.map(line => line.line)).toEqual(["先来壶茶。", "再加一碟花生。"]);
    expect(scene.action).toBe("门外下起了雨。");
  });
});
