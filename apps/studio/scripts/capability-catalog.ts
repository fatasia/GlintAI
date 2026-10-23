import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseProject } from "@glintai/scenescript";

export const CAPABILITIES = [
  { id: "make", input: "资料/想法/代码库", output: "SceneScript + MP4 + 质量/修复报告", network: "配音/模型可选", cost: "启发式免费；模型按供应商计费", recovery: "复用场景/TTS缓存；任务计划可续跑" },
  { id: "render-native", input: "SceneScript", output: "MP4/SRT/配音素材/metrics", network: "本地出帧；在线TTS可选", cost: "本地渲染", recovery: "内容哈希场景缓存" },
  { id: "deck", input: "SceneScript与本地旁白", output: "离线HTML演示目录", network: "无", cost: "本地导出", recovery: "需新目录，拒绝覆盖" },
  { id: "ask", input: "知识源与问题", output: "回答/拒答与检索依据", network: "已配置文本模型", cost: "供应商token", recovery: "可显式重试，不保证逐句事实蕴含" },
  { id: "media", input: "模型/提示词/模型参数", output: "图片/视频/音频资产", network: "媒体网关", cost: "先查pricing；付费提交不可盲重试", recovery: "task ID落盘；--task恢复" },
  { id: "task", input: "有依赖的步骤计划", output: "journal.json + events.jsonl + 产物哈希", network: "取决于步骤", cost: "步骤累计，不存凭据", recovery: "失败步骤续跑；付费媒体只恢复task ID" },
  { id: "qa", input: "MP4", output: "五项量化检查", network: "无", cost: "本地检查", recovery: "检查报告；不是审美保证" },
  { id: "lint", input: "SceneScript", output: "呈现错误与告警", network: "无", cost: "本地检查", recovery: "make有界修复呈现项，不改事实" },
];

export const INSPIRATIONS = [
  { id: "editable-data", title: "数据讲解与共享元素", example: "independent-deck", tags: ["演示", "Magic Move", "图表"] },
  { id: "six-chart-motion", title: "六型图表与转场", example: "fusion-demo", tags: ["图表", "运镜", "音效"] },
  { id: "mixed-code-media", title: "真实素材与代码动画混合", example: "direct-mixed", tags: ["图片", "视频", "HTML", "Three"] },
];

export function listInspiration(query = "") {
  const text = query.toLowerCase();
  return INSPIRATIONS.filter(item => `${item.id} ${item.title} ${item.tags.join(" ")}`.toLowerCase().includes(text));
}

export function instantiateInspiration(id: string, output: string) {
  const entry = INSPIRATIONS.find(item => item.id === id);
  if (!entry) throw new Error("Unknown inspiration ID");
  const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../examples", entry.example);
  const destination = path.resolve(output);
  if (fs.existsSync(destination)) throw new Error("Inspiration destination already exists; no user files were overwritten");
  const project = parseProject(JSON.parse(fs.readFileSync(path.join(source, "project.scenescript.json"), "utf8")));
  fs.mkdirSync(destination, { recursive: true });
  try {
    if (fs.existsSync(path.join(source, "assets"))) fs.cpSync(path.join(source, "assets"), path.join(destination, "assets"), { recursive: true, filter: file => !file.endsWith(".task.json") && !file.endsWith(".result.json") });
    fs.writeFileSync(path.join(destination, "project.scenescript.json"), JSON.stringify(project, null, 2), { flag: "wx" });
    return { projectPath: path.join(destination, "project.scenescript.json"), title: entry.title };
  } catch (error) { fs.rmSync(destination, { recursive: true, force: true }); throw error; }
}
