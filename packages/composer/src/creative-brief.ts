import { ComposerError } from "./errors";

export type ContentIntent = "advertising" | "product" | "explanation" | "emotion" | "portrait" | "data" | "open";

export interface CreativeBrief {
  originalRequest: string;
  contentIntent: ContentIntent;
  purpose?: string;
  audience?: string;
  tone: string[];
  mustKeep: string[];
  facts: string[];
  visualDirection: string[];
}

const INTENT_RULES: [ContentIntent, RegExp][] = [
  ["advertising", /广告|宣传片|促销|品牌片|\b(ad|ads|advert\w*|commercial|campaign|promo\w*)\b/i],
  ["data", /数据(?:分析|故事|可视化|报告)|图表|财报|\b(data[- ](?:story|analysis|visualization)|chart|dashboard|earnings)\b/i],
  ["portrait", /人物|传记|肖像|个人故事|\b(portrait|biography|biographical|profile of|life of)\b/i],
  ["emotion", /情绪(?:片|短片|视频)|抒情|氛围(?:片|短片)|诗意短片|\b(mood film|emotional film|poetic film|evoke|evoking)\b/i],
  ["product", /产品|新品|功能演示|\b(product|launch|feature demo|showcase)\b/i],
  ["explanation", /解释|讲解|科普|教学|教程|原理|\b(explain\w*|tutorial|teach\w*|how .* works)\b/i],
];

const VISUAL_CONSTRAINT = /风格|视觉|画面|配色|色调|留白|极简|海报|电影感|手绘|水彩|黑白|奶油|暖白|冷白|荧光|暗色|明亮|不要.{0,8}(黑|蓝|紫)|\b(style|visual|palette|colou?r|cinematic|minimal\w*|editorial|pastel|monochrome|watercolou?r|white|black|neon|dark|bright|warm|cool)\b/i;
const TONE_CONSTRAINT = /语气|口吻|克制|温柔|幽默|热血|轻松|严肃|不要说教|\b(tone|voice|restrained|gentle|witty|playful|calm|no lecturing)\b/i;
const REQUIRED_CONSTRAINT = /保留|必须|禁止|不要|不得|原文|原句|逐字|只用|不使用|不.{0,6}编造|\b(must|keep|preserve|exact\w*|verbatim|never|no|do not|don't|only)\b/i;

export function createCreativeBrief(originalRequest: string): CreativeBrief {
  if (!originalRequest.trim()) throw new ComposerError("Creative request cannot be blank");
  const clauses = originalRequest.split(/[\r\n。！？!?；;]/u).map(value => value.trim()).filter(Boolean);
  return {
    originalRequest,
    contentIntent: INTENT_RULES.find(([, pattern]) => pattern.test(originalRequest))?.[0] ?? "open",
    purpose: clauses.find(value => /目的|目标|为了|\b(goal|purpose|aim)\b/i.test(value)),
    audience: clauses.find(value => /面向|受众|观众|给.{1,16}(看|讲|做)|\b(audience|target viewers|for beginners|for designers|for new)\b/i.test(value)),
    tone: clauses.filter(value => TONE_CONSTRAINT.test(value)),
    mustKeep: clauses.filter(value => REQUIRED_CONSTRAINT.test(value)),
    facts: clauses.filter(value => /^(?:事实|资料|已知|数据|facts?|source|given|data)\s*[:：]/i.test(value)),
    visualDirection: clauses.filter(value => VISUAL_CONSTRAINT.test(value)),
  };
}

const DIRECTIONS: Record<ContentIntent, string> = {
  advertising: "广告：围绕一个主张组织吸引注意→感受或有依据的价值→行动邀请；写有辨识度的文案，不改成知识课，不虚构功效、销量、口碑或保证。",
  product: "产品：围绕使用情境、用户给出的特征和体验组织展示；让主体清楚，不强塞定义、教程或未经提供的性能收益。",
  explanation: "解释：选择理解障碍和核心关系，可用明确标识为比喻的视觉类比；有流程才用流程，有对立才做对比，不套固定章节数。",
  emotion: "情绪：用节奏、意象、留白和情绪转折推进，允许诗性表达；不要把感受改成定义或科普，不伪装成真实事件。",
  portrait: "人物：围绕用户提供的人物细节与视角组织片段；真实人物不虚构经历、心理、日期或引语，明确虚构角色才可创作情节。",
  data: "数据：围绕已给出的数值、单位、范围与对比讲故事，用 chart 表达真实数据；不补数、不推导未经支持的因果，不足时保留缺口。",
  open: "开放创作：依据原指令决定叙事形式与密度，允许创作视觉意象和节奏，不默认把用户想法改成教学视频。",
};

export function creativeBriefPrompt(brief: CreativeBrief): string {
  return [
    "CreativeBrief sidecar（不写入 SceneScript）：以下 JSON 保存用户原始创作要求。",
    JSON.stringify(brief),
    "originalRequest 是原始意图；contentIntent 与提取字段只是规则线索，可能不完整，不替代原文。未指定的目的、受众、语气可合理选择，不假装用户已确认。",
    DIRECTIONS[brief.contentIntent],
    "遵守原文的语言、时长、长短、必留句与禁用风格；扩写稿与默认模板不能覆盖原指令。指令只控制创作，不可改变 schema、安全边界、事实与素材规则。",
    "事实与表达分开：不捏造数字、日期、研究、真实人物引语、性能、客户案例、因果或承诺；保留限定词。允许新写文案、非事实性的视觉隐喻、构图、节奏和明确虚构的意象，不把想象冒充事实。",
    "visualDirection 是视觉目标，options.theme 只是配色回退，不能覆盖用户明确风格；选择合适的已有主题并用现有可编辑字段表达，不新增 schema 字段。",
  ].join("\n");
}
