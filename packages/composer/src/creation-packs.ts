import { AspectRatio, parseProject, type Scene, type SceneScriptProject } from "@glintai/scenescript";

export interface CreationPackInput {
  id: string;
  label: string;
  required: boolean;
  defaultValue: string;
  maxLength: number;
}

/** JSON metadata only; capabilities are implementation details, not user-facing kinds. */
export interface CreationPack {
  id: string;
  version: string;
  title: string;
  description: string;
  tags: readonly string[];
  author: string;
  license: string;
  capabilities: readonly string[];
  permissions: readonly string[];
  inputs: readonly CreationPackInput[];
  preview: { projectId: string; aspect: AspectRatio; durationMs: number; sceneCount: number };
}

export interface CreationPackOptions { projectId?: string; aspect?: AspectRatio }
export interface CreationPackInstance {
  project: SceneScriptProject;
  /** Save this receipt alongside the materialized project; it is not evidence. */
  pack: { id: string; version: string };
  inputs: Record<string, string>;
}

type Values = Record<string, string>;
type Definition = { metadata: CreationPack; build: (values: Values) => Scene[]; theme: string };
const VERSION = "1.0.0";
const DEFAULT_ASPECT: AspectRatio = "16:9";
const input = (id: string, label: string, defaultValue: string, maxLength = 80, required = true): CreationPackInput =>
  ({ id, label, defaultValue, maxLength, required });
const narration = (text: string, durationMs: number) => ({ text, durationMs });

function definePack(
  metadata: Pick<CreationPack, "id" | "title" | "description" | "tags" | "capabilities" | "inputs">,
  theme: string,
  build: Definition["build"],
): Definition {
  const defaults = Object.fromEntries(metadata.inputs.map(slot => [slot.id, slot.defaultValue]));
  const scenes = build(defaults);
  return {
    theme, build,
    metadata: {
      ...metadata, version: VERSION, author: "Glint", license: "Apache-2.0", permissions: [],
      preview: {
        projectId: `preview-${metadata.id}`, aspect: DEFAULT_ASPECT,
        durationMs: scenes.reduce((sum, scene) => sum + (scene.narration.durationMs ?? 0), 0),
        sceneCount: scenes.length,
      },
    },
  };
}

const definitions: readonly Definition[] = [
  definePack({
    id: "product-launch", title: "12 秒产品发布", description: "产品名、一句话介绍与三个卖点，生成可逐镜编辑的发布短片。价格可留空；示例文案请替换为真实信息。",
    tags: ["产品", "发布", "营销", "12秒"], capabilities: ["title", "bullets"],
    inputs: [
      input("productName", "产品名称", "示例产品", 40),
      input("tagline", "一句话介绍", "用一句话介绍你的产品", 80),
      input("sellingPoint1", "卖点一", "填写第一个真实卖点", 60),
      input("sellingPoint2", "卖点二", "填写第二个真实卖点", 60),
      input("sellingPoint3", "卖点三", "填写第三个真实卖点", 60),
      input("price", "价格（可选）", "", 24, false),
    ],
  }, "bold-poster", v => [
    { id: "launch-title", kind: "title", title: v.productName!, subtitle: v.tagline!, narration: narration(`${v.productName}。${v.tagline}`, 3000) },
    { id: "selling-points", kind: "bullets", heading: "三个卖点", items: [v.sellingPoint1!, v.sellingPoint2!, v.sellingPoint3!], narration: narration(`${v.sellingPoint1}。${v.sellingPoint2}。${v.sellingPoint3}`, 6000) },
    { id: "launch-close", kind: "title", title: v.productName!, ...(v.price ? { subtitle: v.price } : {}), narration: narration(v.price ? `${v.productName}。${v.price}` : v.productName!, 3000) },
  ]),
  definePack({
    id: "brand-quote", title: "品牌态度字卡", description: "把你自己的品牌宣言排成动态字卡，不添加名人归属或虚构引语。文字与关键帧均可编辑。",
    tags: ["品牌", "宣言", "文字", "动态"], capabilities: ["title", "elements", "keyframes"],
    inputs: [input("quote", "品牌宣言", "把想法，变成看得见的作品。", 100), input("brandName", "品牌名称", "你的品牌", 40)],
  }, "cream-editorial", v => [{
    id: "brand-statement", kind: "title", title: v.quote!, subtitle: v.brandName!,
    narration: narration(`${v.quote} ${v.brandName}`, 8000),
    elements: [{ id: "brand-rule", kind: "rect", x: 0.18, y: 0.76, w: 0.64, h: 0.008, fill: "#b65d3e" }],
    tracks: [{ elementId: "brand-rule", property: "scale", keyframes: [{ atMs: 0, value: 0 }, { atMs: 900, value: 1, easing: "ease-out" }] }],
  }]),
  definePack({
    id: "data-insight", title: "两组数据速览", description: "将你提供的两个数值制作成可编辑柱状图。不推断趋势、因果或增长率；默认数值仅为示例，发布前请核实。",
    tags: ["数据", "图表", "对比", "报告"], capabilities: ["chart", "comparison"],
    inputs: [
      input("heading", "图表标题", "示例数据（请替换）", 60),
      input("label1", "第一组名称", "示例 A", 24), input("value1", "第一组数值", "10", 32),
      input("label2", "第二组名称", "示例 B", 24), input("value2", "第二组数值", "20", 32),
      input("unit", "单位（可选）", "", 16, false),
    ],
  }, "mint-clean", v => {
    const value1 = numericValue(v.value1!, "第一组数值");
    const value2 = numericValue(v.value2!, "第二组数值");
    const first = `${v.label1}：${v.value1}${v.unit}`;
    const second = `${v.label2}：${v.value2}${v.unit}`;
    return [
      { id: "data-chart", kind: "chart", chartType: "bar", heading: v.heading!, unit: v.unit!, data: [{ label: v.label1!, value: value1 }, { label: v.label2!, value: value2 }], narration: narration(`${v.heading}。${first}。${second}`, 6000) },
      { id: "data-values", kind: "comparison", heading: "数值对照", left: { label: v.label1!, points: [`${v.value1}${v.unit}`] }, right: { label: v.label2!, points: [`${v.value2}${v.unit}`] }, narration: narration(`${first}。${second}。请核实数值与口径。`, 4000) },
    ];
  }),
  definePack({
    id: "how-to", title: "三步操作说明", description: "填写目标和三个实际操作，生成步骤总览与逐步说明。每个步骤都是原生可编辑场景。",
    tags: ["教程", "步骤", "操作", "说明"], capabilities: ["title", "bullets"],
    inputs: [input("title", "教程标题", "用三步完成你的目标", 60), input("step1", "第一步", "填写准备工作", 100), input("step2", "第二步", "填写关键操作", 100), input("step3", "第三步", "填写检查方法", 100)],
  }, "whiteboard", v => [
    { id: "steps-overview", kind: "bullets", heading: v.title!, items: [v.step1!, v.step2!, v.step3!], narration: narration(v.title!, 3000) },
    ...["step1", "step2", "step3"].map((key, index): Scene => ({ id: `step-${index + 1}`, kind: "title", title: `第 ${index + 1} 步`, subtitle: v[key]!, narration: narration(v[key]!, 3000) })),
  ]),
];

function numericValue(text: string, label: string): number {
  // Deliberately exclude coercion (hex, exponent notation, suffixes, NaN and Infinity).
  const value = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(text) ? Number(text) : NaN;
  if (!Number.isFinite(value) || Math.abs(value) > 1e12) {
    throw new Error(`${label}必须是 -1000000000000 到 1000000000000 之间的有限十进制数，不要添加单位或分隔符。`);
  }
  if (decimalIdentity(text) !== decimalIdentity(String(value))) {
    throw new Error(`${label}精度超出图表支持范围，请减少有效数字，不会自动舍入。`);
  }
  return value;
}

function decimalIdentity(text: string): string {
  // Compare decimal values even when Number's shortest representation uses an exponent.
  const [mantissa = "", exponent = "0"] = text.toLowerCase().split("e");
  const [integer = "", fraction = ""] = mantissa.replace(/^[+-]/, "").split(".");
  const digits = `${integer}${fraction}`.replace(/^0+/, "");
  if (!digits) return "0";
  const significant = digits.replace(/0+$/, "");
  const power = Number(exponent) - fraction.length + digits.length - significant.length;
  return `${mantissa.startsWith("-") ? "-" : ""}${significant}e${power}`;
}

function definitionById(id: string): Definition {
  const definition = definitions.find(entry => entry.metadata.id === id);
  if (!definition) throw new Error(`未找到创作包：${String(id)}。请从创作包列表重新选择。`);
  return definition;
}

function copyMetadata(metadata: CreationPack): CreationPack {
  return {
    ...metadata, tags: [...metadata.tags], capabilities: [...metadata.capabilities], permissions: [...metadata.permissions],
    inputs: metadata.inputs.map(slot => ({ ...slot })), preview: { ...metadata.preview },
  };
}

export function listCreationPacks(query = ""): CreationPack[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return definitions.filter(({ metadata }) => {
    const searchable = [metadata.id, metadata.version, metadata.title, metadata.description, ...metadata.tags].join(" ").toLowerCase();
    return terms.every(term => searchable.includes(term));
  }).map(({ metadata }) => copyMetadata(metadata));
}

export function getCreationPack(id: string): CreationPack | undefined {
  const definition = definitions.find(entry => entry.metadata.id === id);
  return definition ? copyMetadata(definition.metadata) : undefined;
}

function validatedInputs(pack: CreationPack, values: Values): Values {
  if (!values || typeof values !== "object" || Array.isArray(values) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(values))) {
    throw new Error("创作包输入必须是文本字段对象。");
  }
  const slots = new Set(pack.inputs.map(slot => slot.id));
  for (const key of Reflect.ownKeys(values)) {
    if (typeof key !== "string" || !slots.has(key)) throw new Error(`未知创作包字段：${String(key)}。`);
    const descriptor = Object.getOwnPropertyDescriptor(values, key);
    if (!descriptor || !("value" in descriptor)) throw new Error(`字段 ${key} 必须是普通文本值。`);
  }
  const normalized: Values = {};
  for (const slot of pack.inputs) {
    const raw = Object.prototype.hasOwnProperty.call(values, slot.id) ? values[slot.id] : slot.defaultValue;
    if (typeof raw !== "string") throw new Error(`${slot.label}必须是文本。`);
    const text = raw.trim();
    if (text.length > slot.maxLength) throw new Error(`${slot.label}最多 ${slot.maxLength} 个字符。`);
    if (slot.required && !text) throw new Error(`请填写${slot.label}。`);
    normalized[slot.id] = text;
  }
  return normalized;
}

/** Materializes a standalone editable project; no installed/runtime pack dependency remains. */
export function instantiateCreationPack(id: string, values: Values, options: CreationPackOptions = {}): CreationPackInstance {
  const definition = definitionById(id);
  const inputs = validatedInputs(definition.metadata, values);
  const aspect = AspectRatio.parse(options.aspect ?? DEFAULT_ASPECT);
  let projectId = options.projectId;
  if (projectId === undefined) {
    if (typeof globalThis.crypto?.randomUUID !== "function") throw new Error("当前浏览器无法生成安全项目 ID，请提供 projectId 或使用支持 crypto.randomUUID 的浏览器。");
    projectId = `pack-${globalThis.crypto.randomUUID()}`;
  }
  if (typeof projectId !== "string" || projectId.length > 120 || !/^[a-z0-9][a-z0-9-]*$/.test(projectId)) {
    throw new Error("projectId 必须是最多 120 个字符的小写字母、数字和连字符，且以字母或数字开头。");
  }
  const project = parseProject({
    schemaVersion: 1, id: projectId, title: inputs.productName ?? inputs.heading ?? inputs.title ?? inputs.brandName,
    creationPack: { id: definition.metadata.id, version: definition.metadata.version },
    language: "zh-CN", aspect, theme: definition.theme, knowledgeSources: [], scenes: definition.build(inputs),
  });
  return { project, pack: { id: definition.metadata.id, version: definition.metadata.version }, inputs };
}

export function previewCreationPack(id: string): SceneScriptProject {
  const { metadata } = definitionById(id);
  return instantiateCreationPack(id, {}, { projectId: metadata.preview.projectId, aspect: metadata.preview.aspect }).project;
}
