import { expect, it, vi } from "vitest";
import { parseNleProject } from "@glintai/scenescript";
// @ts-expect-error server module
import { proposeNleText } from "./nle-text-proposal.mjs";

const project = parseNleProject({ schemaVersion: 1, id: "demo", title: "片子", fps: 30, width: 1280, height: 720, tracks: [
  { id: "open", kind: "text", name: "字幕", clips: [{ id: "a", kind: "text", text: "原文", startMs: 0, durationMs: 1000 }] },
  { id: "locked", kind: "text", name: "锁定", locked: true, clips: [{ id: "b", kind: "text", text: "保留", startMs: 0, durationMs: 1000 }] },
] });
it("sends only unlocked text and returns a text-only proposal", async () => {
  const chat = vi.fn(async (_request: { messages: Array<{ content: string }> }) => ({ text: JSON.stringify({ edits: [{ id: "a", text: "新文" }] }) }));
  const next = await proposeNleText(project, "精简", { chat }, new AbortController().signal);
  expect(next.tracks[0].clips[0].text).toBe("新文"); expect(next.tracks[1]).toEqual(project.tracks[1]);
  const request = JSON.parse(chat.mock.calls[0]![0].messages[0].content);
  expect(request.clips).toEqual([{ id: "a", trackId: "open", text: "原文", startMs: 0, durationMs: 1000 }]); expect(request).not.toHaveProperty("project");
  expect(request.timelineEndMs).toBe(1000); expect(request.occupied).toEqual([{ trackId: "open", clips: [{ id: "a", startMs: 0, durationMs: 1000 }] }]);
  expect(project.tracks[0]!.clips[0]).toMatchObject({ text: "原文" });
});
it("accepts a valid text-and-timing proposal and rejects same-track collision", async () => {
  const extended = parseNleProject({ ...project, tracks: [
    { ...project.tracks[0], clips: [project.tracks[0]!.clips[0], { id: "c", kind: "text", text: "二", startMs: 2000, durationMs: 1000 }] },
    { ...project.tracks[1], clips: [{ ...project.tracks[1]!.clips[0], durationMs: 4000 }] },
  ] });
  const llm = (value: unknown) => ({ chat: async () => ({ text: JSON.stringify({ edits: [value] }) }) });
  const next = await proposeNleText(extended, "改文字并移动", llm({ id: "a", text: "新文", startMs: 200, durationMs: 1200 }), new AbortController().signal);
  expect(next.tracks[0]!.clips[0]).toMatchObject({ text: "新文", startMs: 200, durationMs: 1200 }); expect(next.tracks[1]).toEqual(extended.tracks[1]);
  await expect(proposeNleText(extended, "移动", llm({ id: "a", startMs: 1500, durationMs: 1000 }), new AbortController().signal)).rejects.toThrow(/重叠/);
});
it("sends existing text style and validates a style proposal", async () => {
  const styled = parseNleProject({ ...project, tracks: [{ ...project.tracks[0], clips: [{ ...project.tracks[0]!.clips[0], fontSize: 40, color: "#123456", weight: 600, align: "left" }] }, project.tracks[1]] });
  const chat = vi.fn(async (_request: { messages: Array<{ content: string }> }) => ({ text: JSON.stringify({ edits: [{ id: "a", fontSize: 48, color: "#abcdef", weight: 700, align: "center" }] }) }));
  const next = await proposeNleText(styled, "字幕居中放大", { chat }, new AbortController().signal);
  expect(next.tracks[0]!.clips[0]).toMatchObject({ fontSize: 48, color: "#abcdef", weight: 700, align: "center" });
  expect(JSON.parse(chat.mock.calls[0]![0].messages[0].content).clips[0]).toMatchObject({ fontSize: 40, color: "#123456", weight: 600, align: "left" });
  expect(next.tracks[1]).toEqual(styled.tracks[1]);
});
it.each([
  { edits: [{ id: "b", text: "坏" }] },
  { edits: [{ id: "a", text: "一" }, { id: "a", text: "二" }] },
  { edits: [{ id: "missing", text: "坏" }] },
  { edits: [{ id: "a", text: " " }] },
  { edits: [{ id: "a", text: "新文", color: "black" }] },
  { edits: [{ id: "a", startMs: -1 }] },
  { edits: [{ id: "a", durationMs: 99 }] },
  { edits: [{ id: "a" }] },
  { edits: [] },
])("rejects invalid model edits", async output => {
  await expect(proposeNleText(project, "改", { chat: async () => ({ text: JSON.stringify(output) }) }, new AbortController().signal)).rejects.toThrow();
});

const manyTextClips = (count: number, text = "原文") => parseNleProject({ ...project, tracks: [{ ...project.tracks[0], clips: Array.from({ length: count }, (_, index) => ({ id: `text-${index}`, kind: "text", text, startMs: index * 1000, durationMs: 1000 })) }] });
it.each([[1, 1024], [2, 1280], [30, 8192], [50, 8192]])("bounds output for %i editable clips at %i tokens", async (count, budget) => {
  const input = manyTextClips(count), before = structuredClone(input);
  const chat = vi.fn(async (_request: { maxOutputTokens: number }) => ({ text: JSON.stringify({ edits: [{ id: "text-0", text: "新文" }] }) }));
  const next = await proposeNleText(input, "修改第一段文字", { chat }, new AbortController().signal);
  expect(chat).toHaveBeenCalledOnce(); expect(chat.mock.calls[0]![0].maxOutputTokens).toBe(budget);
  expect(next.tracks[0]!.clips[0]).toMatchObject({ text: "新文", startMs: 0, durationMs: 1000 }); expect(input).toEqual(before);
});

it("rejects oversized UTF-8 context without truncating it or calling a model", async () => {
  const input = manyTextClips(50, "茶".repeat(500)), before = structuredClone(input), chat = vi.fn();
  await expect(proposeNleText(input, "精简", { chat }, new AbortController().signal)).rejects.toThrow(/32 KiB/);
  expect(chat).not.toHaveBeenCalled(); expect(input).toEqual(before);
});

it("preserves every character and occupancy entry of a large context below the limit", async () => {
  const input = manyTextClips(18, "茶".repeat(500));
  const chat = vi.fn(async (_request: { messages: Array<{ content: string }> }) => ({ text: JSON.stringify({ edits: [{ id: "text-0", text: "新文" }] }) }));
  await proposeNleText(input, "只修改第一段", { chat }, new AbortController().signal);
  const content = chat.mock.calls[0]![0].messages[0]!.content, request = JSON.parse(content);
  expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(32 * 1024);
  expect(request.clips).toHaveLength(18); expect(request.occupied[0].clips).toHaveLength(18);
  expect(request.clips.every((clip: { text: string }) => clip.text === "茶".repeat(500))).toBe(true);
  expect(request.instruction).toBe("只修改第一段"); expect(chat).toHaveBeenCalledOnce();
});

it("keeps a bounded valid context complete and omits unrelated locked-track content", async () => {
  const input = parseNleProject({ ...project, tracks: [project.tracks[0], { ...project.tracks[1], clips: Array.from({ length: 150 }, (_, index) => ({ id: `locked-${index}`, kind: "text", text: "不应发送".repeat(100), startMs: index * 1000, durationMs: 1000 })) }] });
  const chat = vi.fn(async (_request: { messages: Array<{ content: string }>; maxOutputTokens: number }) => ({ text: JSON.stringify({ edits: [{ id: "a", text: "新文" }] }) }));
  const next = await proposeNleText(input, "精简", { chat }, new AbortController().signal);
  const content = chat.mock.calls[0]![0].messages[0]!.content;
  expect(content).not.toContain("不应发送"); expect(content).not.toContain("locked-");
  expect(JSON.parse(content)).toMatchObject({ instruction: "精简", clips: [{ id: "a", text: "原文" }], timelineEndMs: 150000 });
  expect(next.tracks[1]).toEqual(input.tracks[1]); expect(chat.mock.calls[0]![0].maxOutputTokens).toBe(1024);
});

it.each(["", " ", "改".repeat(1001)])("rejects an invalid instruction before any paid call", async instruction => {
  const chat = vi.fn(); await expect(proposeNleText(project, instruction, { chat }, new AbortController().signal)).rejects.toThrow(/1 到 1000/);
  expect(chat).not.toHaveBeenCalled();
});

it("rejects an already aborted request without calling the model", async () => {
  const controller = new AbortController(); controller.abort(); const chat = vi.fn();
  await expect(proposeNleText(project, "修改", { chat }, controller.signal)).rejects.toThrow(); expect(chat).not.toHaveBeenCalled();
});

it("rejects a late model response after cancellation even when the provider ignores the signal", async () => {
  const controller = new AbortController(), before = structuredClone(project);
  let resolveResponse!: (response: { text: string }) => void;
  const response = new Promise<{ text: string }>(resolve => { resolveResponse = resolve; });
  const chat = vi.fn(() => response);
  const pending = proposeNleText(project, "精简", { chat }, controller.signal);
  const rejected = expect(pending).rejects.toThrow("用户已取消");
  expect(chat).toHaveBeenCalledOnce();
  controller.abort(new Error("用户已取消"));
  resolveResponse({ text: JSON.stringify({ edits: [{ id: "a", text: "不应返回的新文" }] }) });
  await rejected;
  expect(chat).toHaveBeenCalledOnce(); expect(project).toEqual(before);
});

it("does not retry incomplete JSON or return a partial edit", async () => {
  const before = structuredClone(project), chat = vi.fn(async () => ({ text: '{"edits":[{"id":"a","text":"新文"}' }));
  await expect(proposeNleText(project, "精简", { chat }, new AbortController().signal)).rejects.toThrow(/完整 JSON.*缩小/);
  expect(chat).toHaveBeenCalledOnce(); expect(project).toEqual(before);
});

it.each([0, 51])("rejects %i unlocked text clips before any model call", async count => {
  const chat = vi.fn(); await expect(proposeNleText(manyTextClips(count), "修改", { chat }, new AbortController().signal)).rejects.toThrow(/1 到 50/);
  expect(chat).not.toHaveBeenCalled();
});
