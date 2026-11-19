// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { SceneScriptProject } from "@glintai/scenescript";
import { StoryboardWorkbench } from "./StoryboardWorkbench";
import { readStoryboardPrefs, shotKey, storyboardPrefsKey, writeStoryboardPrefs } from "./storyboard-prefs";
import type { ScriptDocument } from "./script-documents";
import { buildSeries, setShotEngine } from "@glintai/composer/drama-series";
import { applyStoryboard, storyboardShots } from "./storyboard-project";
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const SCRIPT = "第一场 茶馆 内 日\n老陈擦拭柜台，门外风铃响。\n小满：陈叔，新茶到了吗？\n老陈：到了。\n第二场 街道 外 夜\n雨中，小满快步走。";
const screenplay = (content = SCRIPT): ScriptDocument => ({ id: "play", title: "茶馆", kind: "screenplay", content, updatedAt: 1 });
let dispose = () => {}, sequence = 0;
afterEach(() => { dispose(); document.body.innerHTML = ""; localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const project = (assets: unknown[] = []) => SceneScriptProject.parse({ schemaVersion: 1, id: `board-${++sequence}`, title: "茶馆", aspect: "9:16", knowledgeSources: [], assets, scenes: [{ id: "one", kind: "title", title: "标题", narration: { text: "旁白。", durationMs: 3000 } }] });
async function mount(props: { project?: ReturnType<typeof project>; screenplays?: ScriptDocument[]; onOpenScript?: () => void } = {}) {
  const node = document.createElement("div"); document.body.appendChild(node); const root = createRoot(node);
  const value = { project: props.project ?? project(), screenplays: props.screenplays ?? [screenplay()], onOpenScript: props.onOpenScript ?? vi.fn() };
  await act(async () => root.render(createElement(StoryboardWorkbench, value)));
  dispose = () => act(() => root.unmount());
  return { node, project: value.project };
}
const button = (node: ParentNode, text: string) => { const found = [...node.querySelectorAll("button")].find(item => item.textContent?.trim().startsWith(text)); if (!found) throw new Error(`missing ${text}`); return found as HTMLButtonElement; };
const click = (node: HTMLElement) => act(async () => node.click());

it("offers MG and AIGC as equal first choices, with no preselection", async () => {
  const { node } = await mount();
  const group = node.querySelector('[role="group"][aria-label="默认渲染方式"]')!;
  const choices = [...group.querySelectorAll("button")];
  expect(choices.map(item => item.querySelector("strong")!.textContent)).toEqual(["MG 动态图形", "AIGC 生成画面"]);
  expect(choices.every(item => item.className === choices[0]!.className)).toBe(true);
  expect(choices.some(item => item.getAttribute("aria-pressed") === "true")).toBe(false);
  expect(node.querySelector("table")).toBeNull();
});

it("builds the shot table in the chosen engine, costs MG at zero, and remembers the choice", async () => {
  const { node, project: work } = await mount();
  await click(button(node, "MG 动态图形"));
  const rows = [...node.querySelectorAll("tbody tr:not(.storyboard-scene)")];
  expect(rows.length).toBeGreaterThan(3);
  expect(rows.every(row => row.querySelector('[aria-pressed="true"]')!.textContent === "MG")).toBe(true);
  expect(node.textContent).toContain("MG 0 / AIGC".replace("0", String(rows.length)));
  expect(node.querySelector('[aria-label="费用"]')!.textContent).toContain("¥0");
  expect(readStoryboardPrefs(work.id).defaultEngine).toBe("mg");
});

it("switches one shot to AIGC without touching the others, persists it, and survives a remount", async () => {
  const { node, project: work } = await mount();
  await click(button(node, "MG 动态图形"));
  const first = node.querySelector<HTMLElement>('tbody tr:not(.storyboard-scene) [role="group"]')!;
  await click([...first.querySelectorAll("button")].find(item => item.textContent === "AIGC")!);
  const pressed = [...node.querySelectorAll('tbody tr:not(.storyboard-scene) [role="group"] [aria-pressed="true"]')].map(item => item.textContent);
  expect(pressed[0]).toBe("AIGC");
  expect(pressed.slice(1).every(label => label === "MG")).toBe(true);
  expect(node.querySelector('[aria-label="费用"]')!.textContent).toContain("暂时无法估价");
  expect(Object.values(readStoryboardPrefs(work.id).overrides)).toEqual([{ engine: "aigc" }]);
  dispose(); document.body.innerHTML = "";
  const again = await mount({ project: work });
  expect([...again.node.querySelectorAll('tbody tr:not(.storyboard-scene) [role="group"] [aria-pressed="true"]')].map(item => item.textContent)[0]).toBe("AIGC");
});

it("changes the MG scene kind of a shot", async () => {
  const { node, project: work } = await mount();
  await click(button(node, "MG 动态图形"));
  const select = node.querySelector<HTMLSelectElement>('tbody select[aria-label$="MG 场景类型"]')!;
  await act(async () => { select.value = "chart"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(Object.values(readStoryboardPrefs(work.id).overrides)).toEqual([{ engine: "mg", mgKind: "chart" }]);
});

it("shows character status from the project's own asset identities", async () => {
  const work = project([{ id: "xiaoman", kind: "character", name: "小满", version: "1", description: "二十岁女孩，红色围巾", voice: "girl-1" }]);
  const { node } = await mount({ project: work });
  await click(button(node, "AIGC 生成画面"));
  const roles = node.querySelector('[aria-label="角色"]')!.textContent!;
  expect(roles).toContain("小满有描述，未定稿");
  expect(roles).toContain("老陈还没有角色资产");
});

it("sends the user to write a screenplay when there is none, and explains an unparseable one", async () => {
  const open = vi.fn();
  const empty = await mount({ screenplays: [], onOpenScript: open });
  await click(button(empty.node, "去写剧本"));
  expect(open).toHaveBeenCalledTimes(1);
  dispose(); document.body.innerHTML = "";
  const work = project();
  writeStoryboardPrefs(work.id, { version: 1, defaultEngine: "mg", overrides: {} });
  const bad = await mount({ project: work, screenplays: [screenplay("只是一段散文，没有场景标题。")] });
  expect(bad.node.querySelector('[role="alert"]')!.textContent).toContain("未识别到任何场景标题");
});

it("ignores damaged stored preferences", () => {
  localStorage.setItem(storyboardPrefsKey("x"), "{broken");
  expect(readStoryboardPrefs("x")).toEqual({ version: 1, overrides: {} });
  localStorage.setItem(storyboardPrefsKey("x"), JSON.stringify({ version: 1, defaultEngine: "nope", overrides: { [shotKey("abcdef12", 1)]: { engine: "mg", mgKind: "chart" }, bad: { engine: "mg" }, "abcdef12:2": { engine: "weird" } } }));
  expect(readStoryboardPrefs("x")).toEqual({ version: 1, defaultEngine: undefined, overrides: { "abcdef12:1": { engine: "mg", mgKind: "chart" } } });
});

it("restores a portable mixed storyboard without choosing a new default or changing the project", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ assets: [{ name: "tea.mp4" }] })));
  const work = project(), base = buildSeries(SCRIPT, { engine: "mg", id: work.id, title: work.title, aspect: work.aspect });
  const mixed = setShotEngine(base, base.episodes[0]!.scenes[0]!.shots[0]!.id, "aigc");
  const episode = mixed.episodes[0]!.id, rows = storyboardShots(mixed, episode, "play");
  const saved = applyStoryboard(work, mixed, episode, "play", { [rows[0]!.id]: "tea.mp4" }), before = JSON.stringify(saved);
  const { node } = await mount({ project: saved });
  expect(node.querySelector('[aria-label="默认渲染方式"]')).toBeNull();
  const engines = [...node.querySelectorAll('tbody tr:not(.storyboard-scene) [role="group"] [aria-pressed="true"]')].map(item => item.textContent);
  expect(engines).toEqual(rows.map(row => row.shot.engine === "aigc" ? "AIGC" : "MG"));
  expect(JSON.stringify(saved)).toBe(before);
  expect(readStoryboardPrefs(saved.id).defaultEngine).toBeUndefined();
  dispose(); document.body.innerHTML = "";
  const other = await mount({ project: saved, screenplays: [{ ...screenplay(), id: "other" }] });
  expect(other.node.querySelector('[aria-label="默认渲染方式"]')).not.toBeNull();
  dispose(); document.body.innerHTML = "";
  const extended = await mount({ project: saved, screenplays: [screenplay(SCRIPT + "\n第三场 山顶 外 日\n晨光照亮山顶。")] });
  expect(extended.node.querySelector('[aria-label="默认渲染方式"]')).not.toBeNull();
});
