import {
  defaultPersonas,
  parsePersonaPack,
  type ListenerPersona,
} from "./personas";
export interface PersonaCatalogEntry {
  id: string;
  title: string;
  description: string;
  license: string;
  version: string;
  personas: ListenerPersona[];
}
export interface PersonaCatalog {
  version: 1;
  entries: PersonaCatalogEntry[];
}
export function parsePersonaCatalog(value: unknown): PersonaCatalog {
  const data = value as PersonaCatalog;
  if (
    !data ||
    data.version !== 1 ||
    !Array.isArray(data.entries) ||
    !data.entries.length ||
    data.entries.length > 100
  )
    throw new Error("Catalog requires version 1 and 1..100 entries");
  const seen = new Set<string>();
  return {
    version: 1,
    entries: data.entries.map((entry) => {
      if (
        !entry ||
        typeof entry.id !== "string" ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.id) ||
        seen.has(entry.id) ||
        typeof entry.title !== "string" ||
        !entry.title.trim() ||
        entry.title.length > 80 ||
        typeof entry.description !== "string" ||
        entry.description.length > 500 ||
        typeof entry.license !== "string" ||
        !entry.license.trim() ||
        entry.license.length > 80 ||
        typeof entry.version !== "string" ||
        !/^\d+\.\d+\.\d+$/.test(entry.version)
      )
        throw new Error("Invalid catalog entry");
      seen.add(entry.id);
      return {
        id: entry.id,
        title: entry.title,
        description: entry.description,
        license: entry.license,
        version: entry.version,
        personas: parsePersonaPack({ version: 1, personas: entry.personas }),
      };
    }),
  };
}
export const PERSONA_CATALOG: PersonaCatalog = {
  version: 1,
  entries: [
    {
      id: "general-zh",
      title: "通用听众",
      description: "检查术语、开场和内容节奏。",
      license: "Apache-2.0",
      version: "1.0.0",
      personas: defaultPersonas("zh"),
    },
    {
      id: "general-en",
      title: "English audience",
      description: "Review clarity, relevance and pacing.",
      license: "Apache-2.0",
      version: "1.0.0",
      personas: defaultPersonas("en"),
    },
    {
      id: "technical-review",
      title: "技术审阅",
      description: "逐步检查证据、实现条件和失败情况。",
      license: "Apache-2.0",
      version: "1.0.0",
      personas: [
        {
          id: "engineer",
          name: "实现工程师",
          prompt:
            "指出缺失的输入、实现步骤、可复现条件和失败处理。区分代码事实与推断。",
        },
        {
          id: "evidence-reviewer",
          name: "证据审阅者",
          prompt:
            "检查结论是否超出来源。指出缺少实验或数据的陈述，提出可验证的问题。",
        },
      ],
    },
  ],
};
