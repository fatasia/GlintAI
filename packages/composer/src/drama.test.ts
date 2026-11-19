import { describe, expect, it } from "vitest";
import { splitScreenplay } from "./drama";

const SCRIPT = `第一场 茶馆 内 日

老陈擦拭柜台，门外风铃响。

小满：陈叔，今年的新茶到了吗？

老陈：到了，就等你来尝。

第二场 街道 外 夜

雨中，小满快步走。

小满：这雨，怕是要下一整夜。

第三场 茶馆 内 日

老陈独自煮水。

老陈：人走了，茶还热着。`;

describe("screenplay splitting (DRAMA-01)", () => {
  it("parses scene headings, dialogue and characters", () => {
    const { episodes, characters, issues } = splitScreenplay(SCRIPT);
    expect(issues).toEqual([]);
    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.scenes).toHaveLength(3);
    const first = episodes[0]!.scenes[0]!;
    expect(first).toMatchObject({ location: "茶馆", interior: true, timeOfDay: "日" });
    expect(first.dialogue).toEqual([
      { character: "小满", line: "陈叔，今年的新茶到了吗？" },
      { character: "老陈", line: "到了，就等你来尝。" },
    ]);
    expect(characters[0]).toMatchObject({ name: "小满", lines: 2 });
    expect(characters.map(character => character.name)).toEqual(["小满", "老陈"]);
  });
  it("splits sequentially into episodes of the requested size", () => {
    const { episodes } = splitScreenplay(SCRIPT, { episodeSize: 2 });
    expect(episodes.map(episode => episode.scenes.length)).toEqual([2, 1]);
    expect(episodes[1]!.title).toContain("第 2 集");
    // Cross-episode characters report every episode they appear in (老陈 in E1+E3).
    const chen = episodes.flatMap(episode => episode.characters).filter(name => name === "老陈");
    expect(chen).toHaveLength(2);
  });
  it("handles INT./EXT. headings and reports pre-heading orphans", () => {
    const western = `改稿笔记\n\nINT. CAFE - DAY\n\nMAY: Order up.\n\nEXT. STREET - NIGHT\n\nRain.`;
    const { episodes, issues } = splitScreenplay(western);
    expect(episodes[0]!.scenes).toHaveLength(2);
    expect(episodes[0]!.scenes[0]).toMatchObject({ location: "CAFE", interior: true, timeOfDay: "DAY" });
    expect(episodes[0]!.scenes[1]!.interior).toBe(false);
    expect(issues.join()).toContain("第一个场景标题之前");
  });
  it("returns an empty split with a reason when no heading matches", () => {
    const { episodes, issues } = splitScreenplay("随便一段散文，没有场景。");
    expect(episodes).toEqual([]);
    expect(issues.join()).toContain("未识别到任何场景标题");
  });
});
