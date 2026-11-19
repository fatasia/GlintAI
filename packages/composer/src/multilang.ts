import { VideoPlan, type VideoPlan as Plan } from "./plan";

/**
 * TEAM-05 多语言版本：以已批准工程为底，按镜头翻译表派生另一语言版本。
 * 时间轴、镜头结构、视觉字段全部保持；只有 language、title 与被翻译场景的
 * 旁白文本变化。翻译本身走文本模型（调用方负责），本模块只做确定性派生。
 * 镜头按索引寻址（VideoPlan 的 PlanScene 无独立 id）。
 */
export function deriveLanguageVariant(project: Plan, lang: string, translations: Record<number | string, string>): Plan {
  if (!/^[a-zA-Z-]{2,10}$/.test(lang)) throw new Error(`语言代码不合法：${lang}（应为 2-10 位字母，如 en、zh、pt-BR）`);
  const normalized = new Map(Object.entries(translations).map(([key, text]) => [Number(key), text]));
  const unknown = [...normalized.keys()].filter(index => !Number.isInteger(index) || index < 0 || index >= project.scenes.length);
  if (unknown.length) throw new Error(`翻译表引用了不存在的镜头序号：${unknown.join("、")}；镜头从 0 开始编号`);
  return VideoPlan.parse({
    ...structuredClone(project),
    title: `${project.title}（${lang}）`,
    language: lang,
    scenes: project.scenes.map((scene, index) => {
      const text = normalized.get(index)?.trim();
      return text ? { ...scene, narration: text } : scene;
    }),
  });
}
