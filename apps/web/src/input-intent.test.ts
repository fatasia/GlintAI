import { describe, expect, it } from "vitest";
import { detectQuickVideoMode } from "./input-intent";

const requests = [
  "帮我做一条介绍咖啡店的视频，15秒，高级一点，不要字卡堆砌",
  "为我的产品制作一条竖屏发布视频，先展示使用场景，再介绍卖点，最后引导体验。",
  "用一杯热咖啡和一块冰，解释熵增原理，让零基础观众也能理解。",
  "制作一条整理工作桌面的教程，分为清空、分类、归位三个步骤。",
  "把减少会议时间的三个建议做成速览：会前明确议题、会上控制时间、会后记录行动。",
  "介绍一下这款产品，风格简洁",
  "宣传我们的咖啡店，不要夸张口号",
  "讲清楚量子纠缠，面向小学生",
  "高级一点，不要花哨，15秒",
  "做咖啡店宣传片，别堆文字",
  "15秒",
  "风格高级，不要夸张口号",
  "15秒竖屏视频，突出店铺氛围",
  "Please create a 15-second video for a cafe. Keep it premium, no text cards.",
  "Help me explain entropy with coffee and ice.",
  "Make a portrait promo for our opening.",
  "Don't use slides. Introduce our product in 20 seconds.",
  "Requirements: premium style; duration: 15 seconds; no stock slogans.",
];
const articles = [
  "咖啡店10月1日开业，主打手冲和早餐。前50位到店送一杯手冲，地址为市中心老街18号。",
  "# 本次更新\n\n## 更快\n编辑一镜不再重算整支视频。\n\n## 更省\n只重渲真正改动的镜头。",
  "# 熵增原理\n熵是描述系统状态的物理量。热量由高温处传向低温处。\n请记住，这是一个不可逆的过程。",
  "The cafe opened in October and offers coffee and breakfast.\nMake every morning count is its slogan.",
  "# Product release\nThe product is available on Windows and supports offline editing.\n- Save changed scenes only.\n- Create projects without a subscription.",
  "# 资料\n帮我做一条视频，这是客户访谈中的原话，不是创作指令。",
  "资料：\n请制作一条宣传片，这是待归档的客户原话。",
  "Source: Please create a video. This is quoted interview material.",
  "做咖啡是门手艺。这篇文章介绍制作过程与宣传方法，不是视频创作要求。",
  "咖啡店开业资料\n- 咖啡店于十月开业\n- 宣传活动持续三天\n- 提供高级手冲咖啡",
  "介绍了产品的离线编辑能力。制作过程包括原料准备、加热和冷却。",
  "Reference material\nPlease make every day count. This is a quoted slogan.",
  "已有资料：帮我介绍一下这家公司。这是采访原文。",
  "文章：高级制造业发展迅速，宣传工作需要更多实证。",
  "- 10 月 1 日开业\n- 地址：老街 18 号\n- 主打手冲咖啡和早餐",
];

describe("local input intent", () => {
  it.each(requests)("recognizes a creative brief without a length gate: %s", text => {
    expect(detectQuickVideoMode(text)).toBe("idea");
    expect(detectQuickVideoMode(`${text}\n${"补充品牌背景，展示真实使用场景，不要夸张承诺。".repeat(20)}`)).toBe("idea");
  });
  it.each(articles)("keeps source prose offline: %s", text => {
    expect(detectQuickVideoMode(text)).toBe("source");
    expect(detectQuickVideoMode(text.replace(/\n+/g, " "))).toBe("source");
  });
  it.each([
    ["帮我做一条宣传片\n高级一点\n不要字卡\n15秒", "帮我做一条宣传片，高级一点，不要字卡，15秒"],
    ["# 创作要求\n\n- 帮我介绍咖啡店\n- 高级一点\n- 不要堆字\n- 15秒", "帮我介绍咖啡店，高级一点，不要堆字，15秒"],
    ["1. 制作咖啡店宣传片\r\n2. 高级一点\r\n3. 不要口号", "制作咖啡店宣传片，高级一点，不要口号"],
    ["# Brief\n- Create a cafe promo\n- Style: premium\n- Duration: 15 seconds", "Create a cafe promo. Style: premium. Duration: 15 seconds"],
  ])("keeps line and list variants semantically stable", (multiline, inline) => {
    expect(detectQuickVideoMode(multiline)).toBe("idea");
    expect(detectQuickVideoMode(inline)).toBe("idea");
  });
  it("does not turn length or whitespace into a capability switch", () => {
    for (const size of [20, 79, 80, 200, 2000, 12000]) expect(detectQuickVideoMode(`帮我制作视频，${"好".repeat(size)}`)).toBe("idea");
    for (const text of ["", " \n\r\n ", "咖啡店宣传片", "熵增原理", "Cafe opening"]) expect(detectQuickVideoMode(text)).toBe("idea");
  });
});
