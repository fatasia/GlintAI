import { describe, expect, it } from "vitest";
import { PUBLISH_PRESETS, renderPreset, writePublishKit } from "./publish-presets";

describe("DELIVER-08 export presets", () => {
  it("renders platform-specific title/description from templates", () => {
    const douyin = renderPreset("douyin", { title: "产品发布", hook: "先看产品", takeaway: "体验产品" }, ["短视频"]);
    expect(douyin.title).toBe("先看产品");
    expect(douyin.description).toContain("#短视频");
    const bili = renderPreset("bilibili", { title: "产品发布", hook: "先看产品", takeaway: "体验产品" });
    expect(bili.title).toContain("｜");
    expect(bili.description).toContain("Glint 生成");
  });
  it("rejects unknown platforms and lists available ones", () => {
    expect(() => renderPreset("wechat", { title: "t", hook: "h", takeaway: "k" })).toThrow(/douyin/);
    expect(PUBLISH_PRESETS.length).toBeGreaterThanOrEqual(3);
  });
  it("writes a publish kit file for hand-off", () => {
    const dir = require("node:os").tmpdir() + "/glint-publish-" + Date.now();
    const kit = writePublishKit("shipinhao", { title: "标题", hook: "钩子", takeaway: "要点" }, dir);
    expect(require("node:fs").existsSync(kit.file)).toBe(true);
    require("node:fs").rmSync(dir, { recursive: true, force: true });
  });
});
