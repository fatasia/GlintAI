import type { Scene } from "@glintai/scenescript";
import type { Section } from "./parsing";
import { content, narration, slugify } from "./parsing";
import type { TemplateId } from "./templates";
import { ComposerError } from "./errors";
const points = (s: Section) => (s.listItems.length ? s.listItems : content(s)).slice(0, 4).map((s) => s.slice(0, 90));
const voice = (s: Section) => narration(content(s)) || s.heading;
function definition(s: Section): Scene { return { id: "section", kind: "definition", term: s.heading, definition: narration(content(s), 180) || s.heading, narration: { text: voice(s) } }; }
function bullets(s: Section): Scene { return { id: "section", kind: "bullets", heading: s.heading, items: points(s).length ? points(s) : [s.heading], narration: { text: voice(s) } }; }
function diagram(sections: Section[], heading: string): Scene {
  return { id: "overview", kind: "diagram", heading, steps: sections.slice(0, 5).map((s) => ({ label: s.heading.slice(0, 44), note: points(s)[0]?.slice(0, 80) })), narration: { text: narration(sections.map((s) => s.heading)) } };
}
function comparison(a: Section, b: Section, heading: string): Scene {
  return { id: "comparison", kind: "comparison", heading,
    left: { label: a.heading, points: points(a) }, right: { label: b.heading, points: points(b) },
    narration: { text: narration([voice(a), voice(b)]) } };
}
export function requireTemplateSource(sections: Section[], template: TemplateId): void {
  const matches = (r: RegExp) => sections.filter((s) => r.test(s.heading));
  const pair = (a: RegExp, b: RegExp) => matches(a).length && matches(b).length;
  const ok = template === "versus" || template === "howto" ? sections.length >= 2 || (template === "howto" && (sections[0]?.listItems.length ?? 0) >= 2)
    : template === "paper" ? pair(/方法|method|approach/i, /结果|result|finding/i)
    : template === "timeline" ? matches(/\d{4}|阶段|第.+步|stage|phase/i).length >= 2
    : template === "faq" ? matches(/[?？]|如何|为什么|什么|是否|^(how|why|what|can|does)\b/i).length > 0
    : template === "mythfact" ? pair(/误区|myth/i, /事实|fact/i)
    : template === "case-study" ? matches(/背景|行动|结果|context|action|result/i).length >= 2
    : template === "problem-solution" ? pair(/问题|problem/i, /方案|解决|solution/i)
    : template === "code-walkthrough" ? sections.some((s) => s.code?.text.trim()) : sections.length > 0;
  if (!ok) throw new ComposerError(`Template "${template}" requires structured source material; its prerequisites are not present.`);
}
export function buildSectionScenes(sections: Section[], template: TemplateId, limit: number, title: string): Scene[] {
  requireTemplateSource(sections, template);
  if (limit <= 0) return [];
  let scenes: Scene[];
  switch (template) {
    case "listicle": scenes = sections.map(bullets); break;
    case "versus": scenes = [comparison(sections[0]!, sections[1]!, title), ...sections.slice(2).map(bullets)]; break;
    case "paper": {
      const labels = (s: Section) => /方法|method|approach/i.test(s.heading) ? "方法" : /结果|result|finding/i.test(s.heading) ? "结果" : /问题|背景|background|question/i.test(s.heading) ? "问题" : s.heading;
      const beats = sections.map((s) => ({ ...s, heading: `${labels(s)}：${s.heading}` }));
      const flow = diagram(sections.map((s) => ({ ...s, heading: labels(s) })), "研究主线");
      scenes = limit >= 2 ? [definition(beats[0]!), flow, ...beats.slice(1).map(bullets)] : [flow]; break;
    }
    case "howto": {
      const steps = sections.length >= 2 ? sections : sections[0]!.listItems.map((item, i) => ({ heading: `${i + 1}. ${item.slice(0, 30)}`, sentences: [item], listItems: [], quotes: [] }));
      scenes = [diagram(steps, "步骤总览"), ...steps.map(definition)]; break;
    }
    case "timeline": scenes = [diagram(sections, "时间线"), ...sections.map(definition)]; break;
    case "faq": scenes = sections.filter((s) => /[?？]|如何|为什么|什么|是否|^(how|why|what|can|does)\b/i.test(s.heading)).map(definition); break;
    case "mythfact": scenes = [comparison(sections.find((s) => /误区|myth/i.test(s.heading))!, sections.find((s) => /事实|fact/i.test(s.heading))!, "误区与事实")]; break;
    case "problem-solution": scenes = [comparison(sections.find((s) => /问题|problem/i.test(s.heading))!, sections.find((s) => /方案|解决|solution/i.test(s.heading))!, "问题与方案"), ...sections.map(definition)]; break;
    case "case-study": { const beats = sections.filter((s) => /背景|行动|结果|context|action|result/i.test(s.heading)); scenes = [diagram(beats, "案例路径"), ...beats.map(bullets)]; break; }
    case "code-walkthrough": scenes = sections.filter((s) => s.code?.text.trim()).map((s) => ({ id: "code", kind: "code", heading: s.heading, code: s.code!.text, language: s.code!.language, narration: { text: voice(s) } })); break;
    case "recap": scenes = [bullets({ heading: title, sentences: [], listItems: sections.map((s) => content(s)[0] || s.heading), quotes: [] })]; break;
    default: scenes = sections.map((s) => s.code?.text.trim() ? { id: "code", kind: "code", heading: s.heading, code: s.code.text, language: s.code.language, narration: { text: voice(s) } } : s.quotes[0] ? { id: "quote", kind: "quote", text: s.quotes[0].text, attribution: s.quotes[0].attribution, narration: { text: voice(s) } } : points(s).length >= 2 ? bullets(s) : definition(s));
  }
  const used = new Set(["intro"]);
  return scenes.slice(0, limit).map((scene, i) => {
    const heading = "heading" in scene ? scene.heading : "term" in scene ? scene.term : scene.id;
    const base = slugify(heading || "", `scene-${i + 1}`); let id = base, suffix = 2;
    while (used.has(id)) id = `${base}-${suffix++}`;
    used.add(id); return { ...scene, id };
  });
}
