// @vitest-environment jsdom
// QA-03: three rounds of copy revision must never regress locked scenes,
// theme or aspect. Drives the real EditorAssistant multi-step path.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTimeline, parseProject, type SceneScriptProject } from "@glintai/scenescript";
import { EditorAssistant } from "./EditorAssistant";
import type { SavedProject } from "./project-history";
import { readRevisions, recordRevision, restoreRevision } from "./project-revisions";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

const scenes: SceneScriptProject["scenes"] = [
  { id: "one", kind: "title", title: "开场标题", narration: { text: "第一句", durationMs: 1000 } },
  { id: "two", kind: "title", title: "已批准镜头", narration: { text: "批准文案", durationMs: 2000 }, locked: true },
  { id: "three", kind: "title", title: "结尾标题", narration: { text: "第三句", durationMs: 1500 } },
];
const baseProject = parseProject({ schemaVersion: 1, id: "qa3", title: "QA3", aspect: "16:9", knowledgeSources: [], scenes });
const wrapper = (): SavedProject => ({ id: "qa3", name: "QA3", mode: "source", text: "资料", template: "explainer", theme: "glint-dark", aspect: "16:9", updatedAt: 1, project: baseProject });

let cleanup = () => {};
afterEach(() => { cleanup(); document.body.innerHTML = ""; vi.unstubAllGlobals(); });

async function mount() {
  const div = document.createElement("div"); document.body.appendChild(div);
  const root = createRoot(div), changes: SceneScriptProject[] = [];
  cleanup = () => act(() => root.unmount());
  const render = async (value: SceneScriptProject, sceneId = "one") => {
    await act(async () => root.render(createElement(EditorAssistant, { project: value, sceneId, onChange: next => changes.push(next) })));
  };
  await render(baseProject);
  const input = async (text: string) => act(async () => {
    const element = div.querySelector<HTMLTextAreaElement>('[aria-label="分镜修改指令"]')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(element, text);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const send = async () => act(async () => [...div.querySelectorAll("button")].find(button => button.textContent === "AI 修改本分镜")!.click());
  const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  return { div, changes, render, input, send, settle };
}

/** edit-scene stub: rewrites only the asked scene, keeps every other field. */
const editReply = (body: { sceneId?: string }, round: number) => Response.json({ project: (() => {
  const next = structuredClone(baseProject);
  const scene = next.scenes.find(item => item.id === body.sceneId);
  if (scene) (scene as { title: string }).title = `第${round}轮·${scene.id}`;
  return next;
})() });

describe("QA-03 three revision rounds keep locked content, theme and aspect", () => {
  it("survives three sequential revision rounds without locked regression", async () => {
    const storage = new MemoryStorage();
    let current = baseProject;
    let round = 0;
    const lockStart = buildTimeline(baseProject).entries.find(entry => entry.scene.id === "two")!.startMs;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      const target = String(url), body = init?.body ? JSON.parse(String(init.body)) : {};
      if (target.endsWith("/api/assistant/plan")) return Response.json({ steps: [
        { sceneId: "one", action: `第${round}轮改开场` },
        { sceneId: "three", action: `第${round}轮改结尾` },
      ] });
      return editReply(body, round);
    }));
    const h = await mount();
    for (const label of ["标题更短", "结尾更口语", "整体再润色一轮"]) {
      round++;
      await h.render(current, "one");
      await h.input(label);
      await h.send();
      await h.settle();
      expect(h.changes).toHaveLength(round);
      current = h.changes[round - 1]!;
      const lockedScene = current.scenes.find(scene => scene.id === "two")!;
      expect(lockedScene).toEqual(baseProject.scenes[1]);
      expect(current.aspect).toBe("16:9");
      expect(buildTimeline(current).entries.find(entry => entry.scene.id === "two")!.startMs).toBe(lockStart);
      const saved = recordRevision({ ...wrapper(), project: current }, { label: `改稿第${round}轮`, reason: "manual", storage });
      expect(saved).not.toBeNull();
      const stored = readRevisions("qa3", storage);
      expect(stored[0]!.label).toBe(`改稿第${round}轮`);
      expect(stored[0]!.snapshot.theme).toBe("glint-dark");
    }
    const first = readRevisions("qa3", storage).at(-1)!;
    const restored = restoreRevision(first);
    expect(restored.theme).toBe("glint-dark");
    expect(restored.aspect).toBe("16:9");
    expect(restored.project!.scenes.find(scene => scene.id === "two")).toEqual(baseProject.scenes[1]);
  });

  it("refuses a multi-step plan that targets the locked scene and applies nothing", async () => {
    const storage = new MemoryStorage();
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      const target = String(url), body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push(target);
      if (target.endsWith("/api/assistant/plan")) return Response.json({ steps: [
        { sceneId: "two", action: "顺手改已批准镜头" },
        { sceneId: "one", action: "改开场" },
      ] });
      return editReply(body, 1);
    }));
    const h = await mount();
    await h.input("把整片都改好");
    await h.send();
    await h.settle();
    expect(h.changes).toHaveLength(0);
    expect(h.div.textContent).toContain("已锁定");
    expect(calls.filter(url => url.endsWith("/api/edit-scene"))).toHaveLength(0);
    expect(readRevisions("qa3", storage)).toHaveLength(0);
  });
});
