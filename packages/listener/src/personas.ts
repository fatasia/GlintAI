export interface ListenerPersona {
  id: string;
  name: string;
  /** Who they are and when they would get lost or scroll away. */
  prompt: string;
}
export function parsePersonaPack(value: unknown): ListenerPersona[] {
  const pack = value as { version?: unknown; personas?: unknown };
  if (!pack || pack.version !== 1 || !Array.isArray(pack.personas) || pack.personas.length < 1 || pack.personas.length > 10) throw new Error("Persona pack requires version 1 and 1..10 personas");
  const seen = new Set<string>();
  return pack.personas.map((entry: ListenerPersona) => {
    if (!entry || typeof entry.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.id) || seen.has(entry.id) || typeof entry.name !== "string" || !entry.name.trim() || entry.name.length > 80 || typeof entry.prompt !== "string" || !entry.prompt.trim() || entry.prompt.length > 3000) throw new Error("Invalid or duplicate persona");
    seen.add(entry.id); return { id: entry.id, name: entry.name, prompt: entry.prompt };
  });
}

export const ZH_PERSONAS: ListenerPersona[] = [
  {
    id: "curious-student",
    name: "好奇的高中生",
    prompt:
      "你是一名高二学生,刚学完课本上的基础概念。你会认真听,但任何跳跃的推理、没解释的术语、太快带过的步骤,都会让你真实地卡住。",
  },
  {
    id: "busy-investor",
    name: "零基础投资人",
    prompt:
      "你是一名对技术零基础的投资人,只关心「这和我有什么关系」「结论是什么」。注意力很短,八秒钟抓不到重点你就会失去耐心。",
  },
  {
    id: "casual-scroller",
    name: "刷到视频的路人",
    prompt:
      "你是刷短视频时随机刷到这条讲解的路人。任何超过一句话的铺垫、开头没钩子、中间没画面感的段落,都会让你直接划走。",
  },
];

export const EN_PERSONAS: ListenerPersona[] = [
  {
    id: "curious-student",
    name: "Curious high-schooler",
    prompt:
      "You are a high-school junior who just learned the textbook basics. You listen carefully, but any skipped reasoning step, unexplained term, or rushed transition genuinely loses you.",
  },
  {
    id: "busy-investor",
    name: "Non-technical investor",
    prompt:
      "You are a non-technical investor who only cares about what this means for you and the conclusion. Your attention span is short; if the point is not visible within eight seconds, you tune out.",
  },
  {
    id: "casual-scroller",
    name: "Casual scroller",
    prompt:
      "You are a random passer-by who scrolled onto this explainer. Any long setup, a hook-less opening, or a stretch with no concrete image makes you swipe away.",
  },
];

export function defaultPersonas(language?: string): ListenerPersona[] {
  return language && language.startsWith("en") ? EN_PERSONAS : ZH_PERSONAS;
}
