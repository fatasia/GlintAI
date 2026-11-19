import { describe, expect, it, vi } from "vitest";
import { MockLlmProvider, type ChatRequest } from "@glintai/llm";
import { composeFromSource } from "./source";
import { composeWithLlm } from "./llm";
import { createCreativeBrief } from "./creative-brief";

const source = "# Slow coffee\n\nLeave room for a quiet moment.";
const intro = { id: "intro", kind: "title", title: "Slow coffee", narration: { text: "Leave room for a quiet moment." } };
const reply = (theme: string | undefined = "mint-clean", scenes: unknown[] = [intro]) => JSON.stringify({
  schemaVersion: 1, id: "creative", title: "Slow coffee", aspect: "16:9", theme, scenes,
});
const embeddedBrief = (request: ChatRequest) => JSON.parse(request.system!.split("\n").find(line => line.startsWith('{"originalRequest"'))!);

function twoStageProvider(modelReply = reply()) {
  const requests: ChatRequest[] = [];
  const llm = new MockLlmProvider(request => {
    requests.push(request);
    return requests.length === 1 ? source : modelReply;
  });
  return { llm, requests };
}

describe("creative source to composer contract without keys or network", () => {
  it.each([
    "做一支咖啡广告。暖白极简，禁止蓝紫，不要教学；逐字保留‘慢一点’。",
    "Create a restrained coffee commercial. Keep ‘Slow down.’ verbatim. Visual style: warm white, not dark blue.",
    "做咖啡广告\n风格：暖白极简，不要蓝紫\n保留‘慢一点’，不编造功效",
    `做咖啡广告。风格：暖白极简，不要蓝紫。${"保留‘慢一点’，不要讲成科普。".repeat(25)}`,
  ])("preserves the original request across exactly one expansion and one composition: %s", async originalRequest => {
    const { llm, requests } = twoStageProvider();
    const result = await composeFromSource({ idea: originalRequest }, llm, { theme: "glint-dark" });
    expect(requests).toHaveLength(2);
    expect(requests[0]!.messages).toEqual([{ role: "user", content: originalRequest }]);
    expect(requests[1]!.messages[0]!.content).toContain(source);
    expect(embeddedBrief(requests[0]!)).toMatchObject({ originalRequest, contentIntent: "advertising" });
    expect(embeddedBrief(requests[1]!)).toEqual(embeddedBrief(requests[0]!));
    expect(result.creativeBrief?.originalRequest).toBe(originalRequest);
    expect(result.sourceText).toBe(source);
    expect(result.project).not.toHaveProperty("creativeBrief");
    expect(result.project.theme).toBe("mint-clean");
    expect(requests[0]!.system).not.toContain("4-6 个 H2");
    expect(requests[1]!.system).not.toContain("资料没有类比、案例或数字时，不添加");
  });

  it("makes creativity, facts, existing visual abilities and web boundaries actionable in both prompts", async () => {
    const { llm, requests } = twoStageProvider();
    await composeFromSource({ idea: "产品展示：风格克制，不编造参数" }, llm);
    for (const request of requests) {
      expect(request.system).toContain("不捏造数字");
      expect(request.system).toContain("diagram");
      expect(request.system).toContain("chart");
      expect(request.system).toContain("image");
      expect(request.system).toContain("HTML");
      expect(request.system).toContain("3D");
    }
    expect(requests[1]!.system).toContain("image: src:string");
    expect(requests[1]!.system).toContain("elements:");
    expect(requests[1]!.system).toContain("不是已核验事实来源");
    expect(requests[1]!.json).toBe(true);
  });

  it("keeps theme fallback and pinned non-idea behavior while allowing requested visual style", async () => {
    const provider = new MockLlmProvider(() => reply());
    const normal = await composeWithLlm(source, provider, { theme: "glint-dark" });
    const unspecified = await composeWithLlm(source, provider, { theme: "glint-dark" }, { creativeBrief: createCreativeBrief("产品展示") });
    const styled = await composeWithLlm(source, provider, { theme: "glint-dark" }, { creativeBrief: createCreativeBrief("产品展示，暖白极简风格") });
    const noTheme = JSON.parse(reply());
    delete noTheme.theme;
    const missing = await composeWithLlm(source, new MockLlmProvider(() => JSON.stringify(noTheme)), { theme: "glint-dark" }, { creativeBrief: createCreativeBrief("暖白极简产品广告") });
    expect(normal.theme).toBe("glint-dark");
    expect(unspecified.theme).toBe("mint-clean");
    expect(styled.theme).toBe("mint-clean");
    expect(missing.theme).toBe("glint-dark");
  });

  it("does not gate an unrecognized style on inference rules", async () => {
    const creativeBrief = createCreativeBrief("做成包豪斯感的产品广告");
    expect(creativeBrief.visualDirection).toEqual([]);
    const project = await composeWithLlm(source, new MockLlmProvider(() => reply()), { theme: "glint-dark" }, { creativeBrief });
    expect(project.theme).toBe("mint-clean");
  });

  it("detects missing model language from the original request rather than a drifted expansion", async () => {
    const brief = createCreativeBrief("做一支咖啡广告，温柔克制");
    const project = await composeWithLlm(source, new MockLlmProvider(() => reply()), {}, { creativeBrief: brief });
    const explicit = await composeWithLlm(source, new MockLlmProvider(() => reply()), { language: "en-US" }, { creativeBrief: brief });
    expect(project.language).toBe("zh-CN");
    expect(explicit.language).toBe("en-US");
  });

  it("preserves brief and constraints during the existing schema repair", async () => {
    const requests: ChatRequest[] = [];
    const originalRequest = "咖啡广告，暖白极简，必须保留‘慢一点’";
    const llm = new MockLlmProvider(request => {
      requests.push(request);
      return requests.length === 1 ? source : requests.length === 2 ? "invalid JSON" : reply();
    });
    await composeFromSource({ idea: originalRequest }, llm);
    expect(requests).toHaveLength(3);
    expect(embeddedBrief(requests[2]!)).toEqual(embeddedBrief(requests[1]!));
    expect(requests[2]!.system).toContain("validation diagnostics");
  });

  it("keeps concurrent ideas isolated and does not mutate caller options", async () => {
    const options = Object.freeze({ theme: "glint-dark" });
    const llm = new MockLlmProvider(request => request.json ? reply() : source);
    const [a, b] = await Promise.all([
      composeFromSource({ idea: "广告，风格暖白" }, llm, options),
      composeFromSource({ idea: "解释缓存原理" }, llm, options),
    ]);
    expect(a.creativeBrief?.originalRequest).toBe("广告，风格暖白");
    expect(b.creativeBrief?.contentIntent).toBe("explanation");
    expect(a.project.theme).toBe("mint-clean");
    expect(b.project.theme).toBe("mint-clean");
    expect(options.theme).toBe("glint-dark");
  });

  it("carries explicit template structure to expansion without fabricating prerequisites", async () => {
    const requests: ChatRequest[] = [];
    const llm = new MockLlmProvider(request => { requests.push(request); return "# Source\nNo real dates, methods or results supplied."; });
    await expect(composeFromSource({ idea: "整理论文，不虚构数据" }, llm, { template: "paper" })).rejects.toThrow(/prerequisites/);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.system).toContain("显式模板结构合同");
    expect(requests[0]!.system).toContain("不得为了通过模板虚构");
  });

  it.each(["before expansion", "during expansion", "during composition"])("stops cancellation %s", async stage => {
    const controller = new AbortController();
    const handler = vi.fn((request: ChatRequest) => {
      if ((stage === "during expansion" && !request.json) || (stage === "during composition" && request.json)) controller.abort();
      return request.json ? reply() : source;
    });
    if (stage === "before expansion") controller.abort();
    await expect(composeFromSource({ idea: "咖啡广告" }, new MockLlmProvider(handler), {}, { signal: controller.signal })).rejects.toThrow();
    expect(handler).toHaveBeenCalledTimes(stage === "before expansion" ? 0 : stage === "during expansion" ? 1 : 2);
  });

  it.each(["network 503", "timeout", "unauthorized 401"])("surfaces expansion failure %s without an added round", async message => {
    const handler = vi.fn(() => { throw new Error(message); });
    await expect(composeFromSource({ idea: "咖啡广告" }, new MockLlmProvider(handler))).rejects.toThrow(message);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("rejects blank expansion before another model call", async () => {
    const handler = vi.fn(() => "  ");
    await expect(composeFromSource({ idea: "咖啡广告" }, new MockLlmProvider(handler))).rejects.toThrow("empty");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it.each([
    { id: "unsupported", kind: "html", html: "<p>not supported here</p>", narration: { text: "Source." } },
    { id: "unsupported", kind: "three", model: "sphere", narration: { text: "Source." } },
    { id: "unsupported", kind: "image", src: "assets/invented.png", narration: { text: "Source." } },
  ])("rejects model output outside creative capabilities: $kind", async scene => {
    await expect(composeWithLlm(source, new MockLlmProvider(() => reply("mint-clean", [intro, scene])), {}, {
      creativeBrief: createCreativeBrief("产品广告，不使用 HTML 或 3D，不编造素材"), repairAttempts: 0,
    })).rejects.toThrow(/supported|supplied/);
  });

  it("accepts existing image, diagram and chart shapes without extending SceneScript", async () => {
    const scenes = [intro,
      { id: "product", kind: "image", src: "assets/product.png", presentation: "showcase", narration: { text: "Product." } },
      { id: "steps", kind: "diagram", steps: [{ label: "Open" }, { label: "Use" }], narration: { text: "Open and use." } },
      { id: "numbers", kind: "chart", chartType: "bar", data: [{ label: "A", value: 2 }], narration: { text: "A is two." } },
    ];
    const project = await composeWithLlm(source, new MockLlmProvider(() => reply("mint-clean", scenes)), {}, {
      creativeBrief: createCreativeBrief("产品广告，素材：assets/product.png；事实：A=2；步骤：Open→Use"),
    });
    expect(project.scenes.map(scene => scene.kind)).toEqual(["title", "image", "diagram", "chart"]);
  });
});
