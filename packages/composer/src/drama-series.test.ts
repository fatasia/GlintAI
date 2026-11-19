import { describe, expect, it } from "vitest";
import { createRegistry } from "@glintai/models";
import { applyIdentities, buildSeries, checkContinuity, lookFor, quoteEpisode, refreshPrompts, reimportScreenplay, ScreenplayError, Series, setShotEngine, shotTable, shotTableCsv, type Series as SeriesType } from "./drama-series";

const SCRIPT = `第一场 茶馆 内 日
老陈擦拭柜台，门外风铃响。
小满推门进来，抖落肩上的雪。
小满：陈叔，今年的新茶到了吗？
老陈：到了，就等你来尝。
小满：那我先尝一杯，再决定要不要带走，最好是明前的头采，味道最干净的那一种。
第二场 街道 外 夜
雨中，小满快步走。
小满：这雨，怕是要下一整夜。`;

const registry = createRegistry([
  { id: "img", name: "图", provider: "g", kind: "image", capabilities: ["text-to-image"], pricing: { basis: "per-image", amountCny: 0.2 }, adapter: { type: "openai-images", model: "m" } },
  { id: "vid", name: "视频", provider: "g", kind: "video", capabilities: ["image-to-video"], pricing: { basis: "per-second", amountCny: 0.5 }, adapter: { type: "skills-gateway", model: "v" } },
  { id: "tts", name: "配音", provider: "g", kind: "speech", capabilities: ["text-to-speech"], pricing: { basis: "per-1k-chars", amountCny: 0.3 }, adapter: { type: "skills-gateway", model: "s" } },
  { id: "mystery", name: "未知", provider: "g", kind: "image", capabilities: [], pricing: { basis: "unknown" }, adapter: { type: "openai-images", model: "m" } },
]);

const build = (overrides = {}) => buildSeries(SCRIPT, { engine: "aigc", id: "demo", title: "茶馆", aspect: "9:16", style: { name: "电影感", prompt: "电影质感，柔和侧光" }, ...overrides });

describe("buildSeries", () => {
  it("produces a schema-valid series with stable ids", () => {
    const series = build();
    expect(Series.safeParse(series).success).toBe(true);
    expect(series.characters.map(c => [c.id, c.name])).toEqual([["char-1", "小满"], ["char-2", "老陈"]]);
    expect(series.locations.map(l => [l.id, l.name, l.interior])).toEqual([["loc-1", "茶馆", true], ["loc-2", "街道", false]]);
    expect(series.episodes[0]!.scenes.map(s => s.id)).toEqual(["ep-1-sc-1", "ep-1-sc-2"]);
    expect(build()).toEqual(series);
  });

  it("opens each scene with an establishing wide shot and keeps script order", () => {
    const shots = build().episodes[0]!.scenes[0]!.shots;
    expect(shots[0]).toMatchObject({ size: "wide", move: "push-in", id: "ep-1-sc-1-sh-1" });
    expect(shots[0]!.action).toBe("老陈擦拭柜台，门外风铃响。");
    expect(shots[1]).toMatchObject({ size: "medium", characterIds: ["char-1"] });
    expect(shots[1]!.action).toContain("小满推门进来");
    expect(shots.slice(2).map(s => s.dialogue[0]!.characterId)).toEqual(["char-1", "char-2", "char-1"]);
  });

  it("frames replies as over-the-shoulder and long lines as close-ups, splitting very long lines", () => {
    const shots = build().episodes[0]!.scenes[0]!.shots;
    const reply = shots.find(s => s.dialogue[0]?.line === "到了，就等你来尝。")!;
    expect(reply.size).toBe("over-shoulder");
    expect(reply.characterIds).toEqual(["char-2", "char-1"]);
    const longLine = shots.filter(s => s.dialogue[0]?.characterId === "char-1" && s.id !== shots[2]!.id && s.size === "close");
    expect(longLine.length).toBeGreaterThanOrEqual(1);
    expect(shots.every(s => s.durationMs >= 1000 && s.durationMs <= 15000)).toBe(true);
  });

  it("raises ScreenplayError with the parser's reasons when nothing parses", () => {
    expect(() => buildSeries("没有场景标题的散文", { engine: "aigc" })).toThrow(ScreenplayError);
    try { buildSeries("没有场景标题的散文", { engine: "aigc" }); } catch (error) { expect((error as ScreenplayError).issues.join()).toContain("未识别到任何场景标题"); }
  });
});

describe("prompts", () => {
  it("put the style, framing, place, looks and action in every prompt, and the move in the video prompt", () => {
    const series = build();
    const shot = series.episodes[0]!.scenes[0]!.shots[0]!;
    expect(shot.imagePrompt).toContain("电影质感，柔和侧光");
    expect(shot.imagePrompt).toContain("远景");
    expect(shot.imagePrompt).toContain("茶馆");
    expect(shot.videoPrompt).toContain("镜头缓慢推近");
    expect(shot.videoPrompt).toContain("3秒");
  });

  it("carry the approved look of a character into every shot they appear in", () => {
    const series = build();
    const looks = series.characters.map(c => c.id === "char-1" ? { ...c, looks: [{ ...c.looks[0]!, prompt: "二十岁女孩，红色围巾", approved: true }] } : c);
    const refreshed = refreshPrompts({ ...series, characters: looks });
    const shots = refreshed.episodes[0]!.scenes.flatMap(s => s.shots).filter(s => s.characterIds.includes("char-1"));
    expect(shots.length).toBeGreaterThan(2);
    expect(shots.every(s => s.imagePrompt.includes("小满（二十岁女孩，红色围巾）"))).toBe(true);
  });

  it("choose the explicit look, else the first approved, else the first", () => {
    const base = build().characters[0]!;
    const character = { ...base, looks: [{ ...base.looks[0]!, id: "a" }, { ...base.looks[0]!, id: "b", approved: true }, { ...base.looks[0]!, id: "c" }] };
    expect(lookFor({}, character).id).toBe("b");
    expect(lookFor({ lookIds: { [character.id]: "c" } }, character).id).toBe("c");
    expect(lookFor({}, { ...character, looks: [character.looks[0]!] }).id).toBe("a");
  });
});

describe("reimportScreenplay", () => {
  const approve = (series: SeriesType): SeriesType => ({
    ...series,
    characters: series.characters.map(c => c.id === "char-1" ? { ...c, voice: { engine: "tts-x", voiceId: "girl-1" }, looks: [{ ...c.looks[0]!, prompt: "红围巾", approved: true, referenceAssetIds: ["asset-1"] }] } : c),
    episodes: series.episodes.map(e => ({ ...e, scenes: e.scenes.map(s => ({ ...s, shots: s.shots.map(shot => ({ ...shot, status: "approved" as const, firstFrameAssetId: `frame-${shot.id}` })) })) })),
  });

  it("keeps ids, looks, voices and every asset of scenes whose text did not change", () => {
    const original = approve(build());
    const result = reimportScreenplay(original, SCRIPT);
    expect(result.keptScenes).toBe(2);
    expect(result.changedScenes).toBe(0);
    expect(result.series.characters[0]).toEqual(original.characters[0]);
    expect(result.series.episodes[0]!.scenes[1]!.shots.every(s => s.status === "approved" && s.firstFrameAssetId)).toBe(true);
  });

  it("regenerates only the scene that changed and keeps approved looks", () => {
    const original = approve(build());
    const edited = SCRIPT.replace("这雨，怕是要下一整夜。", "雨停了，我们走吧。");
    const result = reimportScreenplay(original, edited);
    expect(result.keptScenes).toBe(1);
    expect(result.changedScenes).toBe(1);
    const [kept, changed] = result.series.episodes[0]!.scenes;
    expect(kept!.shots.every(s => s.status === "approved")).toBe(true);
    expect(changed!.shots.every(s => s.status === "draft" && !s.firstFrameAssetId)).toBe(true);
    expect(changed!.shots.some(s => s.dialogue[0]?.line === "雨停了，我们走吧。")).toBe(true);
    expect(result.series.characters[0]!.looks[0]!.approved).toBe(true);
    expect(result.series.episodes[0]!.scenes[0]!.shots[1]!.imagePrompt).toContain("红围巾");
  });

  it("matches a renamed character by alias and reports new and departed characters", () => {
    const original = approve(build());
    const withAlias: SeriesType = { ...original, characters: original.characters.map(c => c.id === "char-2" ? { ...c, aliases: ["陈师傅"] } : c) };
    const edited = SCRIPT.replace(/老陈/g, "陈师傅") + "\n第三场 码头 外 日\n阿海：船要开了。";
    const result = reimportScreenplay(withAlias, edited);
    expect(result.series.characters.find(c => c.name === "陈师傅" || c.aliases.includes("陈师傅"))!.id).toBe("char-2");
    expect(result.newCharacters).toEqual(["阿海"]);
    expect(result.series.characters.find(c => c.name === "阿海")!.id).toBe("char-3");
    expect(result.goneCharacters).toEqual([]);
  });
});

describe("checkContinuity", () => {
  const codes = (series: SeriesType) => checkContinuity(series).map(i => `${i.level}:${i.code}`);

  it("warns about unapproved looks and nothing else on a fresh import", () => {
    const issues = checkContinuity(build());
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every(i => i.level === "warn" && i.code === "look-not-approved")).toBe(true);
  });

  it("is clean once the looks are approved", () => {
    const series = build();
    const approved = { ...series, characters: series.characters.map(c => ({ ...c, looks: c.looks.map(l => ({ ...l, approved: true })) })) };
    expect(checkContinuity(approved)).toEqual([]);
  });

  it("catches broken references, impossible timing and a speaker who is not in the shot", () => {
    const series = build();
    const mutate = (fn: (shots: SeriesType["episodes"][0]["scenes"][0]["shots"]) => void) => {
      const copy = structuredClone(series); fn(copy.episodes[0]!.scenes[0]!.shots); return copy;
    };
    expect(codes(mutate(s => { s[1]!.characterIds = ["char-9"]; }))).toContain("error:unknown-character");
    expect(codes(mutate(s => { s[1]!.locationId = "loc-9"; }))).toContain("error:unknown-location");
    expect(codes(mutate(s => { s[1]!.durationMs = 20000; }))).toContain("error:bad-duration");
    expect(codes(mutate(s => { s[2]!.characterIds = []; }))).toContain("error:speaker-not-in-shot");
    expect(codes(mutate(s => { s[2]!.id = s[1]!.id; }))).toContain("error:duplicate-shot");
    expect(codes(mutate(s => { s.length = 0; }))).toContain("error:scene-empty");
  });

  it("warns when a scene does not open wide and when a look jumps inside a scene", () => {
    const series = build();
    const copy = structuredClone(series);
    const shots = copy.episodes[0]!.scenes[0]!.shots;
    shots[0]!.size = "close";
    copy.characters[0]!.looks.push({ id: "char-1-look-2", name: "风衣", prompt: "", referenceAssetIds: [], approved: false });
    const person = shots.filter(s => s.characterIds.includes("char-1"));
    person[1]!.lookIds = { "char-1": "char-1-look-2" };
    const result = codes(copy);
    expect(result).toContain("warn:no-establishing");
    expect(result).toContain("warn:look-jump");
  });
});

describe("quoteEpisode", () => {
  it("prices references, first frames, video seconds rounded up per shot, and speech", () => {
    const series = build();
    const result = quoteEpisode(series, "ep-1", registry, { imageModelId: "img", videoModelId: "vid", speechModelId: "tts" }, { capCny: 500 });
    const shots = series.episodes[0]!.scenes.flatMap(s => s.shots);
    const seconds = shots.reduce((sum, s) => sum + Math.ceil(s.durationMs / 1000), 0);
    expect(result.shots).toBe(shots.length);
    expect(result.seconds).toBe(seconds);
    expect(result.lines.map(l => l.label.split("（")[0])).toEqual(["参考图", "AIGC 首帧图", "AIGC 视频", "配音"]);
    expect(result.lines[0]!.quote.costCny).toBe(0.8);
    expect(result.lines[1]!.quote.costCny).toBe(Math.round(shots.length * 0.2 * 10000) / 10000);
    expect(result.lines[2]!.quote.costCny).toBe(seconds * 0.5);
    expect(result.budget).toMatchObject({ ok: true });
  });

  it("bills video seconds rounded up per shot, never down", () => {
    const series = structuredClone(build());
    series.episodes[0]!.scenes.forEach(scene => scene.shots.forEach(shot => { shot.durationMs = 2200; }));
    const count = series.episodes[0]!.scenes.reduce((sum, scene) => sum + scene.shots.length, 0);
    expect(quoteEpisode(series, "ep-1", registry, { imageModelId: "img", videoModelId: "vid" }).seconds).toBe(count * 3);
  });

  it("stops at the budget cap and on an unknown price", () => {
    const series = build();
    expect(quoteEpisode(series, "ep-1", registry, { imageModelId: "img", videoModelId: "vid" }, { capCny: 1 }).budget).toMatchObject({ ok: false, reason: "over-budget" });
    expect(quoteEpisode(series, "ep-1", registry, { imageModelId: "mystery", videoModelId: "vid" }).budget).toMatchObject({ ok: false, reason: "unknown-cost" });
  });

  it("charges nothing for references that already exist", () => {
    const series = build();
    const done: SeriesType = { ...series, characters: series.characters.map(c => ({ ...c, looks: c.looks.map(l => ({ ...l, approved: true })) })), locations: series.locations.map(l => ({ ...l, referenceAssetIds: ["a"] })) };
    expect(quoteEpisode(done, "ep-1", registry, { imageModelId: "img", videoModelId: "vid" }).lines[0]!.quote.costCny).toBe(0);
  });

  it("refuses the wrong kind of model and an unknown episode", () => {
    const series = build();
    expect(() => quoteEpisode(series, "ep-1", registry, { imageModelId: "vid", videoModelId: "vid" })).toThrow(/不是图像模型/);
    expect(() => quoteEpisode(series, "ep-1", registry, {})).toThrow(/需要选择图像模型和视频模型/);
    expect(() => quoteEpisode(series, "ep-1", registry, { imageModelId: "img", videoModelId: "img" })).toThrow(/不是视频模型/);
    expect(() => quoteEpisode(series, "ep-1", registry, { imageModelId: "img", videoModelId: "vid", speechModelId: "img" })).toThrow(/不是语音模型/);
    expect(() => quoteEpisode(series, "ep-9", registry, { imageModelId: "img", videoModelId: "vid" })).toThrow(/Unknown episode/);
  });
});

describe("shot table", () => {
  it("lists every shot with speaker, line, characters and location", () => {
    const rows = shotTable(build(), "ep-1");
    expect(rows[0]).toMatchObject({ episode: 1, shot: 1, size: "远景", move: "镜头缓慢推近", seconds: 3, location: "茶馆" });
    expect(rows.find(r => r.line === "到了，就等你来尝。")).toMatchObject({ speaker: "老陈", characters: "老陈、小满", size: "过肩镜头" });
  });

  it("exports CSV with quoting and a formula guard", () => {
    const rows = shotTable(build(), "ep-1").slice(0, 2);
    const csv = shotTableCsv([{ ...rows[0]!, line: "=HYPERLINK(\"http://x\")" }, { ...rows[1]!, line: "他说，\"走\"" }]);
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe("集,场景,镜号,方式,景别,运镜,秒,说话人,台词/动作,出镜角色,地点,状态");
    expect(lines[1]).toContain("\"'=HYPERLINK(\"\"http://x\"\")\"");
    expect(lines[2]).toContain("\"他说，\"\"走\"\"\"");
  });
});

describe("MG and AIGC are equal choices", () => {
  const mgSeries = () => build({ engine: "mg" });

  it("lets the user start the whole series in either engine and records the choice", () => {
    expect(build().defaultEngine).toBe("aigc");
    const mg = mgSeries();
    expect(mg.defaultEngine).toBe("mg");
    expect(mg.episodes[0]!.scenes.flatMap(s => s.shots).every(s => s.engine === "mg")).toBe(true);
    expect(Series.safeParse(mg).success).toBe(true);
  });

  it("gives MG shots a built-in scene kind by the same rule the plan pipeline uses, and no image or video prompt", () => {
    const shots = mgSeries().episodes[0]!.scenes.flatMap(s => s.shots);
    expect(shots.filter(s => s.dialogue.length).every(s => s.mgKind === "quote")).toBe(true);
    expect(shots.filter(s => !s.dialogue.length).every(s => s.mgKind === "title")).toBe(true);
    expect(shots.every(s => s.imagePrompt === "" && s.videoPrompt === "")).toBe(true);
  });

  it("does not ask for character looks, or warn about them, where nobody has to be drawn", () => {
    expect(checkContinuity(mgSeries())).toEqual([]);
    expect(checkContinuity(build()).some(i => i.code === "look-not-approved")).toBe(true);
  });

  it("quotes an all-MG episode at zero without any model, and says why", () => {
    const result = quoteEpisode(mgSeries(), "ep-1", registry, {});
    expect(result.aigcShots).toBe(0);
    expect(result.mgShots).toBe(result.shots);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toMatchObject({ label: expect.stringContaining("MG 渲染"), quote: { costCny: 0, explain: "本机渲染，不产生费用" } });
    expect(result.budget).toMatchObject({ ok: true, knownCny: 0 });
  });

  it("prices a mixed episode: only AIGC shots cost images and video, speech covers every shot", () => {
    let series = build();
    const first = series.episodes[0]!.scenes[0]!.shots;
    for (const shot of first.slice(0, 3)) series = setShotEngine(series, shot.id, "mg");
    const all = series.episodes[0]!.scenes.flatMap(s => s.shots);
    const aigc = all.filter(s => s.engine === "aigc"), mg = all.filter(s => s.engine === "mg");
    const result = quoteEpisode(series, "ep-1", registry, { imageModelId: "img", videoModelId: "vid", speechModelId: "tts" });
    expect(result.aigcShots).toBe(aigc.length);
    expect(result.mgShots).toBe(3);
    const seconds = aigc.reduce((sum, s) => sum + Math.ceil(s.durationMs / 1000), 0);
    expect(result.lines.find(l => l.label.startsWith("AIGC 视频"))!.quote.costCny).toBe(seconds * 0.5);
    expect(result.lines.find(l => l.label.startsWith("MG"))!.quote.costCny).toBe(0);
    const chars = all.reduce((sum, s) => sum + s.dialogue.reduce((n, d) => n + d.line.length, 0), 0);
    expect(result.lines.find(l => l.label.startsWith("配音"))!.quote.explain).toContain(`${chars} 字`);
  });

  it("switches a single shot either way and keeps everything else", () => {
    const series = build();
    const target = series.episodes[0]!.scenes[0]!.shots[2]!;
    const toMg = setShotEngine(series, target.id, "mg");
    const after = toMg.episodes[0]!.scenes[0]!.shots[2]!;
    expect(after).toMatchObject({ engine: "mg", mgKind: "quote", imagePrompt: "" });
    expect(toMg.episodes[0]!.scenes[0]!.shots[1]).toEqual(series.episodes[0]!.scenes[0]!.shots[1]);
    expect(setShotEngine(toMg, target.id, "mg", "chart").episodes[0]!.scenes[0]!.shots[2]!.mgKind).toBe("chart");
    const back = setShotEngine(toMg, target.id, "aigc").episodes[0]!.scenes[0]!.shots[2]!;
    expect(back.engine).toBe("aigc");
    expect(back.mgKind).toBeUndefined();
    expect(back.imagePrompt).not.toBe("");
    expect(() => setShotEngine(series, "nope", "mg")).toThrow(/Unknown shot/);
  });

  it("reports an MG shot with no scene kind", () => {
    const series = structuredClone(mgSeries());
    delete series.episodes[0]!.scenes[0]!.shots[0]!.mgKind;
    expect(checkContinuity(series).map(i => i.code)).toContain("mg-kind-missing");
  });

  it("keeps the series engine on re-import and shows it in the shot table", () => {
    const series = mgSeries();
    const result = reimportScreenplay(series, SCRIPT.replace("这雨，怕是要下一整夜。", "雨停了。"));
    expect(result.series.defaultEngine).toBe("mg");
    expect(result.series.episodes[0]!.scenes[1]!.shots.every(s => s.engine === "mg")).toBe(true);
    expect(shotTable(series, "ep-1")[0]!.engine).toBe("MG");
    expect(shotTable(build(), "ep-1")[0]!.engine).toBe("AIGC");
  });
});

describe("applyIdentities", () => {
  const identity = (over: Record<string, unknown> = {}) => ({ id: "xiaoman", kind: "character", name: "小满", version: "1", description: "二十岁女孩，红色围巾", voice: "girl-1", refs: ["assets/a.png"], ...over }) as never;

  it("takes the look, voice and references from the project identity", () => {
    const series = applyIdentities(build(), [identity()]);
    const character = series.characters.find(c => c.name === "小满")!;
    expect(character.looks).toEqual([{ id: "char-1-xiaoman", name: "小满 v1", prompt: "二十岁女孩，红色围巾", referenceAssetIds: ["assets/a.png"], approved: false }]);
    expect(character.voice).toEqual({ engine: "project-identity", voiceId: "girl-1" });
    expect(series.episodes[0]!.scenes[0]!.shots[1]!.imagePrompt).toContain("小满（二十岁女孩，红色围巾）");
  });

  it("is approved only when the identity carries an approval for its current version", () => {
    const approval = { version: "2", name: "小满", description: "二十岁女孩，红色围巾", voice: "girl-1", refs: ["assets/approved-x.png"] };
    const current = applyIdentities(build(), [identity({ version: "2", approval })]).characters[0]!.looks[0]!;
    expect(current).toMatchObject({ approved: true, referenceAssetIds: ["assets/approved-x.png"] });
    const stale = applyIdentities(build(), [identity({ version: "3", approval })]).characters[0]!.looks[0]!;
    expect(stale.approved).toBe(false);
  });

  it("leaves unmatched characters alone and fills location references", () => {
    const series = applyIdentities(build(), [identity({ id: "tea", kind: "location", name: "茶馆", description: "老式木桌，暖黄灯光", refs: ["assets/tea.png"] })]);
    expect(series.characters).toEqual(build().characters);
    expect(series.locations.find(l => l.name === "茶馆")).toMatchObject({ prompt: "老式木桌，暖黄灯光", referenceAssetIds: ["assets/tea.png"] });
  });
});