import { parseProject } from "@glintai/scenescript";

/**
 * Minimal project used as the Remotion Studio default. Real projects come
 * in through inputProps; see examples/entropy-lecture for a full one.
 */
export const SAMPLE_PROJECT = parseProject({
  schemaVersion: 1,
  id: "sample",
  title: "Glint 示例",
  language: "zh-CN",
  aspect: "16:9",
  fps: 30,
  knowledgeSources: [],
  theme: "glint-dark",
  scenes: [
    {
      id: "intro",
      kind: "title",
      title: "Glint",
      subtitle: "讲解,第一次可以被验证",
      narration: { text: "欢迎来到 Glint。这是一个由 SceneScript 驱动的讲解项目。" },
    },
    {
      id: "define",
      kind: "definition",
      term: "SceneScript",
      definition:
        "Glint 的场景中间表示:每个讲解页是一个对象,可以被试讲、被提问、被重讲。",
      narration: {
        text: "SceneScript 是 Glint 的场景中间表示,它让重讲和提问成为可能。",
      },
    },
    {
      id: "outro",
      kind: "bullets",
      heading: "讲解的三个环节",
      items: ["发布前:虚拟听众试讲", "观看时:观众可以提问", "发布后:哪页没讲清,看得见"],
      narration: {
        text: "Glint 把试讲、对话和理解检查放在同一个创作流程中。",
      },
    },
  ],
});
