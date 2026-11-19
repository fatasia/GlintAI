import { describe, expect, it } from "vitest";
import { createCreativeBrief, creativeBriefPrompt } from "./creative-brief";

const intents = [
  ["为咖啡品牌写一支广告，不要说教", "advertising"],
  ["Create a coffee brand commercial. Keep it restrained.", "advertising"],
  ["展示这款产品的使用情境", "product"],
  ["Create a product showcase for designers", "product"],
  ["用简单方式解释熵的原理", "explanation"],
  ["Explain how compound interest works", "explanation"],
  ["拍一支情绪短片，写雨后的思念", "emotion"],
  ["Create a poetic film evoking homesickness", "emotion"],
  ["做一支人物传记，只用提供的经历", "portrait"],
  ["Create a biographical portrait of a teacher", "portrait"],
  ["用数据可视化展示已给出的季度收入", "data"],
  ["Make a data story about the supplied revenue", "data"],
  ["一颗种子，一次出发", "open"],
] as const;

describe("CreativeBrief inference without a model", () => {
  it.each(intents)("uses an intent hint for %s", (request, intent) => {
    expect(createCreativeBrief(request).contentIntent).toBe(intent);
  });

  it("keeps a three-line English request byte-for-byte and extracts only supplied constraints", () => {
    const request = "  Create a product commercial for designers.\r\nVisual style: warm white, minimal. Keep ‘Less, but alive.’ verbatim.\r\nFacts: price is $39.95; do not invent any performance guarantee.  ";
    const brief = createCreativeBrief(request);
    expect(brief.originalRequest).toBe(request);
    expect(brief.visualDirection.join("\n")).toContain("Visual style: warm white, minimal.");
    expect(brief.mustKeep.join("\n")).toContain("Keep ‘Less, but alive.’ verbatim.");
    expect(brief.facts).toEqual(["Facts: price is $39.95"]);
    expect(brief.purpose).toBeUndefined();
    expect(brief.audience).toContain("for designers");
    const embedded = creativeBriefPrompt(brief).split("\n").find(line => line.startsWith('{"originalRequest"'))!;
    expect(JSON.parse(embedded).originalRequest).toBe(request);
  });

  it("treats long and short equivalent requests as the same direction without truncating either", () => {
    const short = "做咖啡广告；风格：暖白极简；不要蓝紫；保留“慢一点，香一点”";
    const long = `${short}。${"让镜头留有呼吸，不要把它改成教学课件。".repeat(20)}`;
    const a = createCreativeBrief(short);
    const b = createCreativeBrief(long);
    expect(b.contentIntent).toBe(a.contentIntent);
    expect(b.visualDirection).toEqual(a.visualDirection);
    expect(b.mustKeep).toEqual(expect.arrayContaining(a.mustKeep));
    expect(b.originalRequest).toBe(long);
    expect(b.originalRequest.length).toBeGreaterThan(300);
  });

  it("leaves unspecified claims, audience and tone empty instead of inventing a promise", () => {
    const brief = createCreativeBrief("产品展示");
    expect(brief).toMatchObject({ facts: [], mustKeep: [], tone: [], visualDirection: [] });
    expect(brief.purpose).toBeUndefined();
    expect(brief.audience).toBeUndefined();
    expect(creativeBriefPrompt(brief)).toContain("可能不完整，不替代原文");
  });

  it("retains Unicode, punctuation, quoted constraints and explicit purpose", () => {
    const request = '目标：让新观众认识“栀子”\n语气：温柔、克制\n必须逐字保留「停一下」。只用黑白，不使用 HTML。';
    const brief = createCreativeBrief(request);
    expect(brief.originalRequest).toBe(request);
    expect(brief.purpose).toBe('目标：让新观众认识“栀子”');
    expect(brief.tone).toEqual(["语气：温柔、克制"]);
    expect(brief.mustKeep).toContain("必须逐字保留「停一下」");
    expect(brief.visualDirection).toContain("只用黑白，不使用 HTML");
  });

  it.each(["", " \r\n\t "])("rejects a blank request %j", request => {
    expect(() => createCreativeBrief(request)).toThrow("cannot be blank");
  });
});
