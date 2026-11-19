import { expect, it } from "vitest";
import { parseEditorProject } from "./editor-model";
import { captureChapter, chaptersDocument, CHAPTERS_KEY, mergeChapters, moveChapter, parseChaptersDocument, readChapters, summarizeChapters, writeChapters, type ChapterContext } from "./ChaptersStore";
const context: ChapterContext = { mode: "source", text: "资料", template: "explainer", theme: "glint-dark", evidence: "依据" };
const project = (id: string) => parseEditorProject({ schemaVersion: 1, id, title: `章节 ${id}`, aspect: "16:9", knowledgeSources: [], scenes: [
  { id: "one", kind: "title", title: "第一镜", narration: { text: "旁白", durationMs: 2000 } },
  { id: "two", kind: "title", title: "第二镜", narration: { text: "下一句", durationMs: 1000 }, transition: { in: "fade", overlapMs: 200 } },
] });
function storage() { const values = new Map<string, string>(); return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } }; }

it("captures isolated editable snapshots and round trips their source context", () => {
  const source = project("one"), chapter = captureChapter(source, context), store = storage();
  source.title = "changed"; context.text = "changed";
  expect(chapter.project.title).toBe("章节 one"); expect(chapter.context.text).toBe("资料"); context.text = "资料";
  writeChapters([chapter], store); expect(readChapters(store)).toEqual([chapter]);
  expect(JSON.parse(store.getItem(CHAPTERS_KEY)!)).toMatchObject({ kind: "glint.chapters.references", version: 1 });
});
it("validates every imported editor project and rejects executable or oversized projects", () => {
  const chapter = captureChapter(project("one"), context);
  expect(() => parseChaptersDocument({ ...chaptersDocument([chapter]), chapters: [chapter, { ...chapter, project: { ...chapter.project, id: "bad", scenes: [] } }] })).toThrow();
  expect(() => chaptersDocument([{ ...chapter, project: { ...chapter.project, scenes: Array.from({ length: 31 }, (_, i) => ({ ...chapter.project.scenes[0]!, id: `s${i}` })) } }])).toThrow(/30/);
  expect(() => parseChaptersDocument({ version: 1, chapters: [{ project: chapter.project, assets: [] }] })).toThrow(/CLI/);
});
it("merges only new project identities, rejects duplicates, and caps local JSON", () => {
  const first = captureChapter(project("one"), context), second = captureChapter(project("two"), context);
  expect(mergeChapters([first], [second])).toHaveLength(2);
  expect(() => mergeChapters([first], [captureChapter(project("one"), context)])).toThrow(/重复/);
  expect(() => chaptersDocument(Array.from({ length: 101 }, (_, i) => captureChapter(project(`c${i}`), context)))).toThrow(/100/);
  expect(() => chaptersDocument(Array.from({ length: 25 }, (_, i) => captureChapter(project(`c${i}`), { ...context, evidence: "x".repeat(90_000) })))).toThrow(/2 MB/);
});
it("never replaces a previously stored document when validation or storage fails", () => {
  const store = storage(), chapter = captureChapter(project("one"), context); writeChapters([chapter], store); const before = store.getItem(CHAPTERS_KEY);
  expect(() => writeChapters([{ ...chapter, title: " " }], store)).toThrow(); expect(store.getItem(CHAPTERS_KEY)).toBe(before);
  expect(() => writeChapters([], { ...store, setItem: () => { throw new Error("quota"); } })).toThrow(/quota/); expect(store.getItem(CHAPTERS_KEY)).toBe(before);
  store.setItem(CHAPTERS_KEY, "broken"); expect(() => readChapters(store)).toThrow(); expect(store.getItem(CHAPTERS_KEY)).toBe("broken");
});
it("moves only chapter order, without mutating chapter projects or escaping boundaries", () => {
  const chapters = [captureChapter(project("one"), context), captureChapter(project("two"), context)];
  expect(moveChapter(chapters, "one", -1)).toBe(chapters); expect(moveChapter(chapters, "missing", 1)).toBe(chapters);
  const moved = moveChapter(chapters, "one", 1); expect(moved.map(chapter => chapter.project.id)).toEqual(["two", "one"]); expect(moved[1]).toBe(chapters[0]); expect(chapters[0]!.project.id).toBe("one");
});
it("summarizes actual timeline overlap and labels only shared definitions and paths", () => {
  const asset = { id: "hero", kind: "character", name: "小雨", version: "v1", refs: ["assets/hero.png"] };
  const chapters = ["one", "two"].map(id => captureChapter(parseEditorProject({ ...project(id), assets: [asset] }), context));
  const summary = summarizeChapters(chapters);
  expect(summary).toMatchObject({ scenes: 4, totalMs: 5600, sharedAssets: 1, sharedReferences: 1 });
  expect(summary.chapters[0]).toMatchObject({ totalMs: 2800, sharedAssets: 1, sharedReferences: 1 });
  const conflict = structuredClone(chapters[1]!); conflict.project.assets![0]!.name = "不同定义";
  expect(() => mergeChapters([chapters[0]!], [conflict])).toThrow(/资产 hero · v1 不一致/);
});
