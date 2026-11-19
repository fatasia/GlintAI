// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTimeline, parseProject, type SceneScriptProject } from "@glintai/scenescript";
import { moveReferenceBoundary, splitReferenceAt, ReferenceBuilder } from "./ReferenceBuilder";
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let cleanup = () => {};
afterEach(() => { cleanup(); document.body.innerHTML = ""; vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const flush = async () => { await act(async () => { await new Promise(done => setTimeout(done, 30)); }); };
function stub(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fetcher = vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => Promise.resolve(handler(String(input), init)));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
async function mount(uploadFile?: (file: File, onProgress: (percent: number) => void, signal: AbortSignal) => Promise<{ name: string }>) {
  const div = document.createElement("div"); document.body.appendChild(div);
  const root = createRoot(div), projects: unknown[] = [];
  cleanup = () => act(() => root.unmount());
  let changeCurrent!: (value: SceneScriptProject | null) => void;
  function Harness() {
    const [currentProject, setCurrent] = useState<SceneScriptProject | null>(null); changeCurrent = setCurrent;
    return createElement(ReferenceBuilder, { currentProject, onProject: (value: unknown) => { projects.push(value); setCurrent(parseProject(value)); }, ...(uploadFile ? { uploadFile } : {}) });
  }
  await act(async () => root.render(createElement(Harness)));
  await act(async () => { const details = div.querySelector("details")!; details.open = true; details.dispatchEvent(new Event("toggle")); });
  await flush();
  const click = async (text: string) => act(async () => { const target = [...div.querySelectorAll("button")].find(button => button.textContent?.includes(text)); if (!target) throw new Error(`missing ${text}`); target.click(); });
  const consent = async () => act(async () => div.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  const setCurrent = async (value: SceneScriptProject | null) => act(async () => changeCurrent(value));
  return { div, projects, click, consent, setCurrent };
}
const library = () => Response.json({ assets: [{ name: "ref.mp4", url: "/api/media/assets/ref.mp4" }, { name: "poster.png", url: "/api/media/assets/poster.png" }] });
const project = { schemaVersion: 1, id: "reference-1", title: "参考重建（推断）", aspect: "16:9", knowledgeSources: [], scenes: [{ id: "ref-shot-001", kind: "image", src: "assets/ref-1-001.jpg", narration: { text: "参考镜头 1", durationMs: 1000 } }] };
it("splits a single reference scene without losing narration or total duration", () => {
  const original = parseProject({ ...project, scenes: [{ ...project.scenes[0], narration: { text: "人工旁白", durationMs: 3000 } }] });
  const next = splitReferenceAt(original, 1500, "ref-manual-one");
  expect(next.scenes.map(scene => scene.narration.durationMs)).toEqual([1500, 1500]);
  expect(next.scenes.map(scene => scene.narration.text)).toEqual(["人工旁白", "人工旁白"]);
  expect(buildTimeline(next).totalMs).toBe(3000);
  expect(() => splitReferenceAt(original, 50, "ref-manual-two")).toThrow();
  expect(() => splitReferenceAt({ ...original, scenes: [{ ...original.scenes[0]!, locked: true }] }, 1500, "ref-manual-two")).toThrow(/锁定|locked/);
  expect(original.scenes).toHaveLength(1);
});

it("moves a single boundary against the latest project without changing its total or other shots", () => {
  const current = parseProject({ ...project, scenes: [
    project.scenes[0], { ...project.scenes[0], id: "ref-shot-002", narration: { text: "人工更新", durationMs: 2000 } },
    { ...project.scenes[0], id: "ref-shot-003", narration: { text: "第三镜", durationMs: 1000 } },
  ] });
  const adjusted = moveReferenceBoundary(current, "ref-shot-002", "ref-shot-001", 1500);
  expect(adjusted.scenes.map(scene => scene.narration.durationMs)).toEqual([1500, 1500, 1000]);
  expect(adjusted.scenes[1]!.narration.text).toBe("人工更新");
  expect(buildTimeline(adjusted).totalMs).toBe(buildTimeline(current).totalMs);
  expect(() => moveReferenceBoundary(current, "ref-shot-002", "other", 1500)).toThrow(/相邻/);
  expect(() => moveReferenceBoundary(current, "ref-shot-002", "ref-shot-001", 100)).toThrow(/至少/);
  expect(() => moveReferenceBoundary({ ...current, scenes: [{ ...current.scenes[0]!, locked: true }, ...current.scenes.slice(1)] }, "ref-shot-002", "ref-shot-001", 1500)).toThrow(/锁定/);
});

it("moves an overlap transition by its dissolve centre while keeping the overlap and later shots in place", () => {
  const current = parseProject({ ...project, scenes: [
    project.scenes[0],
    { ...project.scenes[0], id: "ref-shot-002", narration: { text: "第二镜", durationMs: 2000 }, transition: { in: "fade", overlapMs: 300 } },
    { ...project.scenes[0], id: "ref-shot-003", narration: { text: "第三镜", durationMs: 1000 } },
  ] });
  const centre = 850; // 交叠区间 700–1000 的中心。
  expect(moveReferenceBoundary(current, "ref-shot-002", "ref-shot-001", centre).scenes[1]!.narration.durationMs).toBe(2000);
  const adjusted = moveReferenceBoundary(current, "ref-shot-002", "ref-shot-001", 1350);
  expect(adjusted.scenes.map(scene => scene.narration.durationMs)).toEqual([1500, 1500, 1000]);
  expect(adjusted.scenes[1]!.transition).toEqual({ in: "fade", overlapMs: 300 });
  const timeline = buildTimeline(adjusted);
  expect(timeline.totalMs).toBe(buildTimeline(current).totalMs);
  // 新转场中心回到目标值：start = 1000+500-300 = 1200，中心 = 1200+150。
  expect(timeline.entries[1]!.startMs).toBe(1200);
  // 转场需保持完整：任一侧剩余不足 overlap+200ms 即拒绝（delta 范围 −500..1500）。
  expect(() => moveReferenceBoundary(current, "ref-shot-002", "ref-shot-001", 349)).toThrow(/转场/);
  expect(() => moveReferenceBoundary(current, "ref-shot-002", "ref-shot-001", 2351)).toThrow(/转场/);
});
it("rejects edits that silently compress neighboring overlaps or produce fractional milliseconds", () => {
  const current = parseProject({ ...project, scenes: [
    { ...project.scenes[0], narration: { text: "一", durationMs: 2000 } },
    { ...project.scenes[0], id: "ref-shot-002", narration: { text: "二", durationMs: 2000 }, transition: { in: "fade", overlapMs: 900 } },
    { ...project.scenes[0], id: "ref-shot-003", narration: { text: "三", durationMs: 2000 }, transition: { in: "fade", overlapMs: 300 } },
    { ...project.scenes[0], id: "ref-shot-004", narration: { text: "四", durationMs: 2000 }, transition: { in: "fade", overlapMs: 900 } },
  ] });
  // Current centre is 2950ms. Both edits keep the edited overlap intact,
  // but would compress the entrance to scene 2 or the entrance to scene 4.
  expect(() => moveReferenceBoundary(current, "ref-shot-003", "ref-shot-002", 1750)).toThrow(/相邻转场/);
  expect(() => moveReferenceBoundary(current, "ref-shot-003", "ref-shot-002", 4150)).toThrow(/相邻转场/);
  const odd = parseProject({ ...project, scenes: [project.scenes[0], { ...project.scenes[0], id: "ref-shot-002", transition: { in: "fade", overlapMs: 301 } }] });
  expect(() => moveReferenceBoundary(odd, "ref-shot-002", "ref-shot-001", 850)).toThrow(/半毫秒/);
  expect(current.scenes.map(scene => scene.narration.durationMs)).toEqual([2000, 2000, 2000, 2000]);
});

describe("reference video to project", () => {
  it("lists only library MP4s and requires rights consent before analysing", async () => {
    const fetcher = stub((url) => url === "/api/media/library" ? library() : Response.json({ project, shots: 1 }));
    const h = await mount();
    const select = h.div.querySelector<HTMLSelectElement>('select[aria-label="选择参考片"]')!;
    expect([...select.options].map(option => option.value)).toEqual(["", "ref.mp4"]);
    await h.click("分析并生成工程");
    expect(fetcher.mock.calls.some(([url]) => String(url) === "/api/reference/build")).toBe(false);
    expect(h.projects).toHaveLength(0);
  });
  it("generates an editable project and states that it is inferred", async () => {
    const fetcher = stub((url) => {
      if (url === "/api/media/library") return library();
      if (url === "/api/reference/build") return Response.json({ project, shots: 1, inferred: true });
      return Response.json({});
    });
    const h = await mount();
    await h.consent(); await h.click("分析并生成工程"); await flush();
    const submit = fetcher.mock.calls.find(([url]) => String(url) === "/api/reference/build")!;
    expect(JSON.parse(String((submit[1] as RequestInit).body))).toEqual({ name: "ref.mp4" });
    expect(h.projects).toEqual([project]);
    expect(h.div.querySelector('[role="status"]')?.textContent).toContain("推断");
    expect(h.div.textContent).toContain("交付前请替换");
  });
  it("only requests local OCR after an explicit opt-in and never writes results to the project", async () => {
    const fetcher = stub(url => url === "/api/media/library" ? library() : Response.json({ project, shots: 1, ocr: { status: "complete", samples: [{ sceneId: "ref-shot-001", requestedMs: 500, status: "recognized", lines: [{ text: "识别文字", score: 0.75 }] }] } }));
    const h = await mount(); await h.consent();
    const option = [...h.div.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')][1]!;
    await act(async () => option.click()); await h.click("分析并生成工程"); await flush();
    const request = fetcher.mock.calls.find(([url]) => String(url) === "/api/reference/build")!;
    expect(JSON.parse(String((request[1] as RequestInit).body))).toEqual({ name: "ref.mp4", ocr: true });
    expect(h.div.textContent).toContain("识别文字"); expect(h.div.textContent).toContain("模型评分 75%");
    expect(h.div.textContent).toContain("非逐字时间码"); expect(h.projects).toEqual([project]);
  });
  it("lets a person correct OCR and explicitly add it as a caption without overwriting edits", async () => {
    stub(url => url === "/api/media/library" ? library() : Response.json({ project, shots: 1, ocr: { status: "complete", samples: [{ sceneId: "ref-shot-001", requestedMs: 500, status: "recognized", lines: [{ text: "原识别", score: 0.75 }] }] } }));
    const h = await mount(); await h.consent(); await h.click("分析并生成工程"); await flush();
    const draft = h.div.querySelector<HTMLTextAreaElement>('textarea[aria-label="人工核对文字 ref-shot-001"]')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(draft, "人工修正"); draft.dispatchEvent(new Event("input", { bubbles: true })); });
    await h.click("写入该镜画面说明");
    expect((h.projects.at(-1) as SceneScriptProject).scenes[0]).toMatchObject({ caption: "人工修正", narration: { text: "参考镜头 1", durationMs: 1000 } });
    expect(h.div.textContent).toContain("该镜已有画面说明");
    await h.click("写入该镜画面说明"); expect(h.projects).toHaveLength(2);
    await h.setCurrent(parseProject({ ...project, scenes: [{ ...project.scenes[0], src: "assets/other.jpg" }] }));
    expect(h.div.textContent).toContain("已过期");
    expect([...h.div.querySelectorAll("button")].find(button => button.textContent === "写入该镜画面说明")!.disabled).toBe(true);
    await h.setCurrent(parseProject({ ...project, scenes: [{ ...project.scenes[0], locked: true }] }));
    expect(h.div.textContent).toContain("该镜已锁定");
    expect([...h.div.querySelectorAll("button")].find(button => button.textContent === "写入该镜画面说明")!.disabled).toBe(true);
  });
  it("accepts manually entered text for a no-text sample and blocks empty drafts", async () => {
    stub(url => url === "/api/media/library" ? library() : Response.json({ project, shots: 1, ocr: { status: "complete", samples: [{ sceneId: "ref-shot-001", requestedMs: 500, status: "no_text", lines: [] }] } }));
    const h = await mount(); await h.consent(); await h.click("分析并生成工程"); await flush();
    const button = [...h.div.querySelectorAll("button")].find(item => item.textContent === "写入该镜画面说明")!;
    expect(button.disabled).toBe(true);
    const draft = h.div.querySelector<HTMLTextAreaElement>('textarea[aria-label="人工核对文字 ref-shot-001"]')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(draft, "人工补录"); draft.dispatchEvent(new Event("input", { bubbles: true })); });
    await h.click("写入该镜画面说明");
    expect((h.projects.at(-1) as SceneScriptProject).scenes[0]).toMatchObject({ caption: "人工补录" });
  });
  it("marks original OCR stale after timing, media or project changes but not narration edits", async () => {
    const twoShots = { ...project, scenes: [project.scenes[0], { ...project.scenes[0], id: "ref-shot-002", src: "assets/ref-1-002.jpg", narration: { text: "二", durationMs: 2000 } }] };
    stub(url => url === "/api/media/library" ? library() : Response.json({ project: twoShots, shots: 2, boundaries: [{ sceneId: "ref-shot-002", startMs: 1000, change: 0.2 }], ocr: { status: "complete", samples: [{ sceneId: "ref-shot-001", requestedMs: 500, status: "recognized", lines: [{ text: "示例", score: 0.75 }] }, { sceneId: "ref-shot-002", requestedMs: 2000, status: "no_text", lines: [] }] } }));
    const h = await mount(); await h.consent(); await h.click("分析并生成工程"); await flush();
    expect(h.div.textContent).not.toContain("已过期");
    await h.setCurrent(parseProject({ ...twoShots, scenes: [{ ...twoShots.scenes[0], narration: { text: "新旁白", durationMs: 1000 } }, twoShots.scenes[1]] }));
    expect(h.div.textContent).not.toContain("已过期");
    await h.setCurrent(moveReferenceBoundary(parseProject(twoShots), "ref-shot-002", "ref-shot-001", 1500));
    expect(h.div.textContent?.match(/已过期/g)).toHaveLength(2);
    await h.setCurrent(parseProject({ ...twoShots, scenes: [{ ...twoShots.scenes[0], src: "assets/user.jpg" }, twoShots.scenes[1]] }));
    expect(h.div.textContent?.match(/已过期/g)).toHaveLength(1);
    await h.setCurrent(parseProject({ ...twoShots, id: "other" }));
    expect(h.div.textContent?.match(/已过期/g)).toHaveLength(2);
  });
  it("exposes uncertain positions without treating them as cuts", async () => {
    stub(url => url === "/api/media/library" ? library() : Response.json({ project, shots: 1, limits: { mergedCuts: 0, omittedCuts: 0, uncertainCuts: [{ timeMs: 1500, reason: "continuing-change" }] } }));
    const h = await mount(); await h.consent(); await h.click("分析并生成工程"); await flush();
    expect(h.div.textContent).toContain("1.50 秒");
    expect(h.div.textContent).toContain("未计入切点，不代表切镜");
    expect(h.projects).toHaveLength(1);
  });
  it("reviews verified source and inserts a one-shot boundary with explicit consent", async () => {
    const full = { ...project, scenes: [{ ...project.scenes[0], narration: { text: "人工旁白", durationMs: 3000 } }] };
    vi.stubGlobal("crypto", { subtle: { digest: vi.fn(async () => new Uint8Array(32).fill(0xaa).buffer) }, randomUUID: () => "11111111-1111-4111-8111-111111111111" });
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:verified"), revokeObjectURL: vi.fn() }));
    stub(url => url === "/api/media/library" ? library() : url.startsWith("/api/media/assets/") ? new Response(new Uint8Array([1, 2, 3])) : Response.json({ project: full, shots: 1, source: { name: "ref.mp4", sha256: "aa".repeat(32), durationMs: 3000 }, limits: { mergedCuts: 0, omittedCuts: 0, uncertainCuts: [{ timeMs: 1500, reason: "weak-local-contrast" }] } }));
    const h = await mount(); await h.consent(); await h.click("分析并生成工程"); await flush();
    await h.click("审阅 1.50 秒"); await flush();
    expect(h.div.querySelector('video[aria-label="原参考片"]')?.getAttribute("src")).toBe("blob:verified");
    expect(h.div.querySelector<HTMLInputElement>('input[aria-label="人工切点秒数"]')?.value).toBe("1.500");
    const insert = [...h.div.querySelectorAll("button")].find(button => button.textContent === "插入人工切点")!;
    expect(insert.disabled).toBe(true);
    await act(async () => h.div.querySelector<HTMLInputElement>('section[aria-label="原片审阅"] input[type="checkbox"]')!.click());
    await h.click("插入人工切点");
    const result = h.projects.at(-1) as SceneScriptProject;
    expect(result.scenes.map(scene => scene.narration.durationMs)).toEqual([1500, 1500]);
    expect(result.scenes.map(scene => scene.narration.text)).toEqual(["人工旁白", "人工旁白"]);
    expect(h.div.textContent).toContain("已插入人工切点");
  });
  it("refuses review of a changed source without modifying the project", async () => {
    vi.stubGlobal("crypto", { subtle: { digest: vi.fn(async () => new Uint8Array(32).fill(0xbb).buffer) }, randomUUID: () => "id" });
    stub(url => url === "/api/media/library" ? library() : url.startsWith("/api/media/assets/") ? new Response(new Uint8Array([1])) : Response.json({ project, shots: 1, source: { name: "ref.mp4", sha256: "aa".repeat(32), durationMs: 3000 }, limits: { mergedCuts: 0, omittedCuts: 0, uncertainCuts: [{ timeMs: 500, reason: "weak-local-contrast" }] } }));
    const h = await mount(); await h.consent(); await h.click("分析并生成工程"); await flush(); await h.click("审阅 0.50 秒"); await flush();
    expect(h.div.textContent).toContain("参考片已变化"); expect(h.div.querySelector("video")).toBeNull(); expect(h.projects).toHaveLength(1);
  });
  it("shows measured boundary change as a measurement rather than a correctness probability", async () => {
    stub(url => url === "/api/media/library" ? library() : Response.json({ project, shots: 2, boundaries: [{ sceneId: "ref-shot-002", startMs: 1200, change: 0.241 }], limits: { mergedCuts: 1, omittedCuts: 2, adaptiveCandidatesSkipped: 3 } }));
    const h = await mount(); await h.consent(); await h.click("分析并生成工程"); await flush();
    expect(h.div.textContent).toContain("ref-shot-002 · 原始 1.20 秒 · 变化强度 24%");
    expect(h.div.textContent).toContain("不是切点正确概率");
    expect(h.div.textContent).toContain("合并近邻切点 1 处 · 超出镜头上限省略 2 处");
    expect(h.div.textContent).toContain("自适应候选因数量上限未复核 3 处（未计入切点）");
  });
  it("reviews and adjusts one boundary on the current project without replacing later edits", async () => {
    const twoShots = { ...project, scenes: [project.scenes[0], { ...project.scenes[0], id: "ref-shot-002", narration: { text: "第二镜", durationMs: 2000 } }] };
    stub(url => url === "/api/media/library" ? library() : Response.json({ project: twoShots, shots: 2, boundaries: [{ sceneId: "ref-shot-002", startMs: 1000, change: 0.2 }] }));
    const h = await mount(); await h.consent(); await h.click("分析并生成工程"); await flush();
    const current = parseProject({ ...twoShots, scenes: [twoShots.scenes[0], { ...twoShots.scenes[1], narration: { text: "用户修改", durationMs: 2000 } }] });
    await h.setCurrent(current);
    const field = h.div.querySelector<HTMLInputElement>('input[aria-label="切点时间 ref-shot-002"]')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "1.5"); field.dispatchEvent(new Event("input", { bubbles: true })); });
    await h.click("调整此切点");
    const result = h.projects.at(-1) as SceneScriptProject;
    expect(result.scenes.map(scene => scene.narration.durationMs)).toEqual([1500, 1500]);
    expect(result.scenes[1]!.narration.text).toBe("用户修改");
    expect(h.div.textContent).toContain("参考帧未重新抽取");
  });
  it("refreshes adjacent midpoint frames after a boundary edit and keeps other scene edits", async () => {
    const twoShots = { ...project, scenes: [project.scenes[0], { ...project.scenes[0], id: "ref-shot-002", src: "assets/ref-1-002.jpg", narration: { text: "第二镜", durationMs: 2000 } }] };
    const names = ["ref-frame-1234567890abcdef12345678-0.jpg", "ref-frame-1234567890abcdef12345678-1.jpg"];
    const fetcher = stub((url, init) => {
      if (url === "/api/media/library") return library();
      if (url === "/api/reference/frames") { expect(JSON.parse(String(init.body))).toEqual({ name: "ref.mp4", sha256: "a".repeat(64), times: [750, 2250] }); return Response.json({ names, times: [750, 2250] }); }
      return Response.json({ project: twoShots, shots: 2, source: { name: "ref.mp4", sha256: "a".repeat(64), durationMs: 3000 }, boundaries: [{ sceneId: "ref-shot-002", startMs: 1000, change: 0.2 }] });
    });
    const h = await mount(); await h.consent(); await h.click("分析并生成工程"); await flush();
    const field = h.div.querySelector<HTMLInputElement>('input[aria-label="切点时间 ref-shot-002"]')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "1.5"); field.dispatchEvent(new Event("input", { bubbles: true })); });
    await h.click("调整此切点"); await h.click("重抽相邻参考帧"); await flush();
    const result = h.projects.at(-1) as SceneScriptProject;
    expect(result.scenes.map(scene => scene.kind === "image" ? scene.src : undefined)).toEqual(names.map(name => `assets/${name}`));
    expect(result.scenes.map(scene => scene.narration.durationMs)).toEqual([1500, 1500]);
    expect(result.scenes[1]!.narration.text).toBe("第二镜");
    expect(fetcher.mock.calls.filter(([url]) => url === "/api/reference/frames")).toHaveLength(1);
  });
  it("refreshes midpoint frames for an overlap transition at each scene's own midpoint", async () => {
    const overlapShots = { ...project, scenes: [
      project.scenes[0],
      { ...project.scenes[0], id: "ref-shot-002", src: "assets/ref-1-002.jpg", narration: { text: "第二镜", durationMs: 2000 }, transition: { in: "fade", overlapMs: 300 } },
    ] };
    const names = ["ref-frame-1234567890abcdef12345678-0.jpg", "ref-frame-1234567890abcdef12345678-1.jpg"];
    // 交叠时间线：右镜 700–2700；两镜中点 = 500 与 1700（不是无交叠的 750/2250）。
    const fetcher = stub((url, init) => {
      if (url === "/api/media/library") return library();
      if (url === "/api/reference/frames") { expect(JSON.parse(String(init.body))).toEqual({ name: "ref.mp4", sha256: "a".repeat(64), times: [500, 1700] }); return Response.json({ names, times: [500, 1700] }); }
      return Response.json({ project: overlapShots, shots: 2, source: { name: "ref.mp4", sha256: "a".repeat(64), durationMs: 3000 }, boundaries: [{ sceneId: "ref-shot-002", startMs: 700, change: 0.2 }] });
    });
    const h = await mount(); await h.consent(); await h.click("分析并生成工程"); await flush();
    await h.click("重抽相邻参考帧"); await flush();
    const result = h.projects.at(-1) as SceneScriptProject;
    expect(result.scenes.map(scene => scene.kind === "image" ? scene.src : undefined)).toEqual(names.map(name => `assets/${name}`));
    expect(result.scenes[1]!.transition).toEqual({ in: "fade", overlapMs: 300 });
    expect(h.div.textContent).not.toContain("转场已变化");
    void fetcher;
  });
  it("does not overwrite a project edited while frame extraction is in flight", async () => {
    const twoShots = { ...project, scenes: [project.scenes[0], { ...project.scenes[0], id: "ref-shot-002", src: "assets/ref-1-002.jpg", narration: { text: "第二镜", durationMs: 2000 } }] };
    let release!: (response: Response) => void;
    stub(url => url === "/api/media/library" ? library() : url === "/api/reference/frames" ? new Promise<Response>(resolve => { release = resolve; }) : Response.json({ project: twoShots, shots: 2, source: { name: "ref.mp4", sha256: "a".repeat(64), durationMs: 3000 }, boundaries: [{ sceneId: "ref-shot-002", startMs: 1000, change: 0.2 }] }));
    const h = await mount(); await h.consent(); await h.click("分析并生成工程"); await flush();
    await h.click("重抽相邻参考帧");
    const changed = parseProject({ ...twoShots, title: "用户的新标题" }); await h.setCurrent(changed);
    await act(async () => { release(Response.json({ names: ["ref-frame-1234567890abcdef12345678-0.jpg", "ref-frame-1234567890abcdef12345678-1.jpg"], times: [500, 2000] })); await Promise.resolve(); }); await flush();
    expect(h.projects).toHaveLength(1); expect(h.div.textContent).toContain("工程在抽帧期间发生变化");
  });
  it("does not replace manually changed media during frame refresh", async () => {
    const twoShots = { ...project, scenes: [project.scenes[0], { ...project.scenes[0], id: "ref-shot-002", src: "assets/ref-1-002.jpg", narration: { text: "第二镜", durationMs: 2000 } }] };
    const fetcher = stub(url => url === "/api/media/library" ? library() : Response.json({ project: twoShots, shots: 2, source: { name: "ref.mp4", sha256: "a".repeat(64), durationMs: 3000 }, boundaries: [{ sceneId: "ref-shot-002", startMs: 1000, change: 0.2 }] }));
    const h = await mount(); await h.consent(); await h.click("分析并生成工程"); await flush();
    await h.setCurrent(parseProject({ ...twoShots, scenes: [twoShots.scenes[0], { ...twoShots.scenes[1], src: "assets/user.jpg" }] }));
    await h.click("重抽相邻参考帧");
    expect(h.div.textContent).toContain("参考帧已被替换");
    expect(fetcher.mock.calls.some(([url]) => url === "/api/reference/frames")).toBe(false); expect(h.projects).toHaveLength(1);
  });
  it("surfaces a concurrent analysis and keeps the current project", async () => {
    stub((url) => {
      if (url === "/api/media/library") return library();
      if (url === "/api/reference/build") return new Response(JSON.stringify({ error: "busy" }), { status: 409 });
      return Response.json({});
    });
    const h = await mount();
    await h.consent(); await h.click("分析并生成工程"); await flush();
    expect(h.projects).toHaveLength(0);
    expect(h.div.querySelector('[role="alert"]')?.textContent).toContain("已有参考分析在运行");
  });
  it("explains an empty library instead of offering a broken control", async () => {
    stub(() => Response.json({ assets: [{ name: "poster.png" }] }));
    const h = await mount();
    expect(h.div.textContent).toContain("还没有 MP4");
    expect([...h.div.querySelectorAll("button")].find(button => button.textContent?.includes("分析并生成工程"))!.disabled).toBe(true);
  });
  it("uploads a chosen MP4 first, then builds the project from the uploaded name", async () => {
    const fetcher = stub((url) => {
      if (url === "/api/media/library") return library();
      if (url === "/api/reference/upload") return Response.json({ name: "upload-abc123.mp4", bytes: 4 });
      if (url === "/api/reference/build") return Response.json({ project, shots: 1, inferred: true });
      return Response.json({});
    });
    const h = await mount(async () => ({ name: "upload-abc123.mp4" }));
    const input = h.div.querySelector<HTMLInputElement>('input[aria-label="上传参考片"]')!;
    const picked = { name: "my-ref.mp4", type: "video/mp4", size: 4 } as File;
    Object.defineProperty(input, "files", { configurable: true, value: [picked] });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    expect(h.div.textContent).toContain("my-ref.mp4");
    await h.consent(); await h.click("上传并生成工程"); await flush();
    const order = fetcher.mock.calls.map(([url]) => String(url)).filter(url => url.startsWith("/api/reference/"));
    expect(order).toEqual(["/api/reference/build"]);
    const build = fetcher.mock.calls.find(([url]) => String(url) === "/api/reference/build")!;
    expect(JSON.parse(String((build[1] as RequestInit).body))).toEqual({ name: "upload-abc123.mp4" });
    expect(h.projects).toEqual([project]);
  });
  it("keeps the current project when the upload is rejected", async () => {
    stub((url) => {
      if (url === "/api/media/library") return library();
      return Response.json({});
    });
    const h = await mount(async () => { throw new Error("Reference upload is too large"); });
    const input = h.div.querySelector<HTMLInputElement>('input[aria-label="上传参考片"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: [{ name: "big.mp4", type: "video/mp4", size: 4 }] });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    await h.consent(); await h.click("上传并生成工程"); await flush();
    expect(h.projects).toHaveLength(0);
    expect(h.div.querySelector('[role="alert"]')?.textContent).toContain("too large");
  });
  it("shows byte progress while uploading, then builds from the returned name", async () => {
    const fetcher = stub((url) => {
      if (url === "/api/media/library") return library();
      if (url === "/api/reference/build") return Response.json({ project, shots: 1, inferred: true });
      return Response.json({});
    });
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const uploadFile = vi.fn(async (_file: File, onProgress: (percent: number) => void) => { onProgress(40); await gate; return { name: "upload-xyz.mp4" }; });
    const h = await mount(uploadFile);
    const input = h.div.querySelector<HTMLInputElement>('input[aria-label="上传参考片"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: [{ name: "ref.mp4", type: "video/mp4", size: 4 }] });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    await h.consent(); await h.click("上传并生成工程");
    await act(async () => { await Promise.resolve(); });
    expect(h.div.textContent).toContain("40%");
    await act(async () => { release(); await gate; });
    await flush();
    const build = fetcher.mock.calls.find(([url]) => String(url) === "/api/reference/build")!;
    expect(JSON.parse(String((build[1] as RequestInit).body))).toEqual({ name: "upload-xyz.mp4" });
    expect(h.projects).toEqual([project]);
  });
});

describe("manual correction writes back into the project (CREATE-10)", () => {
  const styled = parseProject({
    ...project,
    theme: "glint-dark",
    scenes: [{ ...project.scenes[0] }, { ...project.scenes[0], id: "ref-shot-002", narration: { text: "参考镜头 2", durationMs: 2600 } }],
  });
  const style = { palette: [{ hex: "#112233", share: 0.6 }, { hex: "#445566", share: 0.25 }], medianShotMs: 1800 };
  async function mountBuilt() {
    stub((url) => {
      if (url === "/api/media/library") return library();
      if (url === "/api/reference/build") return Response.json({ project: styled, shots: 2, inferred: true, style });
      return Response.json({});
    });
    const h = await mount();
    await h.consent(); await h.click("分析并生成工程"); await flush();
    expect(h.projects).toHaveLength(1); // the inferred proposal loads first
    return h;
  }
  const choose = async (div: HTMLElement, label: string, value: string) => act(async () => {
    const select = div.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  it("keeps the correction disabled until the human changes something", async () => {
    const h = await mountBuilt();
    const apply = [...h.div.querySelectorAll("button")].find(button => button.textContent === "应用纠正并回写工程")!;
    expect(apply.disabled).toBe(true);
    await choose(h.div, "纠正主色", "#112233");
    expect(apply.disabled).toBe(false);
    await choose(h.div, "纠正主色", "");
    expect(apply.disabled).toBe(true);
    expect(h.projects).toHaveLength(1);
  });
  it("writes corrected theme colors and shot seconds back into the project", async () => {
    const h = await mountBuilt();
    await choose(h.div, "纠正主色", "#112233");
    await choose(h.div, "纠正强调色", "#445566");
    const seconds = h.div.querySelector<HTMLInputElement>('input[aria-label="纠正镜长"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(seconds, "2");
      seconds.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await h.click("应用纠正并回写工程");
    expect(h.projects).toHaveLength(2);
    const corrected = h.projects[1] as typeof styled;
    expect(corrected.theme).toEqual({ colors: { bg: "#112233", accent: "#445566" } });
    expect(corrected.scenes.map(scene => scene.narration.durationMs)).toEqual([2000, 2000]);
    // The written-back project stays a valid SceneScript project, and the
    // corrected shot length is what both renderers and the timeline consume.
    const valid = parseProject(JSON.parse(JSON.stringify(corrected)));
    expect(buildTimeline(valid).totalMs).toBe(4000);
    expect(h.div.textContent).toContain("已按人工纠正回写工程");
  });
  it("preserves newer edits, and refuses correction after switching project or locking a shot", async () => {
    const h = await mountBuilt();
    const changed = parseProject({ ...styled, title: "用户修改的标题", scenes: [{ ...styled.scenes[0]!, narration: { ...styled.scenes[0]!.narration, text: "新旁白" } }, styled.scenes[1]!] });
    await h.setCurrent(changed); await choose(h.div, "纠正主色", "#112233"); await h.click("应用纠正并回写工程");
    const corrected = h.projects[1] as typeof styled;
    expect(corrected.title).toBe("用户修改的标题"); expect(corrected.scenes[0]!.narration.text).toBe("新旁白");
    await h.setCurrent(parseProject({ ...changed, id: "other" }));
    const apply = [...h.div.querySelectorAll("button")].find(button => button.textContent === "应用纠正并回写工程")!;
    expect(apply.disabled).toBe(true);
    await h.setCurrent(parseProject({ ...changed, scenes: [{ ...changed.scenes[0]!, locked: true }, changed.scenes[1]!] }));
    const seconds = h.div.querySelector<HTMLInputElement>('input[aria-label="纠正镜长"]')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(seconds, "2"); seconds.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(apply.disabled).toBe(true); expect(h.div.textContent).toContain("含锁定镜头");
  });
  it("rejects malformed color input instead of corrupting the theme", async () => {
    const { applyManualCorrection } = await import("./ReferenceBuilder");
    const broken = applyManualCorrection(styled, { background: "javascript:alert(1)", accent: "#zzzzzz", shotSeconds: 1.5 });
    expect(broken.theme).toBe("glint-dark"); // invalid hex never reaches the theme
    expect(broken.scenes.every(scene => scene.narration.durationMs === 1500)).toBe(true);
  });
});
