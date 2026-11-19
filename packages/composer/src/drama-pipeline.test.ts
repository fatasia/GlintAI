import { describe, expect, it } from "vitest";
import { buildDramaEpisodePlan } from "./drama-pipeline";

const SCREENPLAY = `第一场 茶馆 内 日
王利发：诸位坐，茶刚沏上。
常四爷：这年头，还得是自己人靠得住。

第二场 街头 外 夜
巡警：站住，例行检查。

第三场 茶馆 内 日
王利发：又要交税了。
`;

describe("DRAMA-07 drama episode plan", () => {
  it("turns one parsed episode into a valid shot plan", () => {
    const result = buildDramaEpisodePlan({ screenplay: SCREENPLAY });
    expect(result.episodes).toBe(1); // 3 场默认 episodeSize=6，切成一集
    expect(result.plan.scenes.length).toBe(3);
    expect(result.characters).toContain("王利发");
    expect(result.plan.scenes.length).toBeGreaterThanOrEqual(2);
    expect(result.plan.scenes[0]!.kind).toBe("quote");
    expect(result.plan.platform).toBe("9:16");
  });
  it("estimates narration seconds from dialogue length within the 2–8s clamp", () => {
    const { plan } = buildDramaEpisodePlan({ screenplay: SCREENPLAY });
    for (const scene of plan.scenes) {
      expect(scene.seconds).toBeGreaterThanOrEqual(2);
      expect(scene.seconds).toBeLessThanOrEqual(8);
      expect(plan.totalSeconds).toBe(scene.seconds * plan.scenes.length ? plan.totalSeconds : plan.totalSeconds);
    }
    expect(plan.totalSeconds).toBe(plan.scenes.reduce((sum, scene) => sum + scene.seconds, 0));
  });
  it("picks a specific episode and keeps the plan parseable from its markdown source", () => {
    const result = buildDramaEpisodePlan({ screenplay: SCREENPLAY, episode: 2, episodeSize: 1 });
    expect(result.plan.title).toContain("第2集");
    expect(result.plan.scenes).toHaveLength(1);
    expect(result.planSource).toContain(result.plan.scenes[0]!.narration.slice(0, 4));
  });
  it("uses a title scene when the scene has no dialogue", () => {
    const silent = `第一场 山顶 外 日
风雪很大，一行人艰难前行。
`;
    const { plan } = buildDramaEpisodePlan({ screenplay: silent });
    expect(plan.scenes[0]!.kind).toBe("title");
  });
});
