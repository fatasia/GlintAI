import fs from "node:fs";
import path from "node:path";

/**
 * Generates the practical recipe catalog used by the web template gallery.
 * Each recipe is a real, editable starting point: a short source text plus an
 * existing narrative template, style pack and aspect ratio. No fabricated
 * scenes and no new renderer.
 */
const bases = [
  { id: "product-launch", title: "产品发布", category: "产品", template: "explainer", tags: ["发布", "卖点", "产品"], description: "一句话定位 + 三个卖点 + 结尾行动，适合新品发布。", sample: "# 产品发布\n\n## 一句话\n把资料变成能改的视频。\n\n## 三个卖点\n- 本地优先，素材不上传\n- 改一镜不用重算全片\n- 草稿可继续编辑" },
  { id: "product-ad", title: "产品广告", category: "产品", template: "listicle", tags: ["广告", "卖点", "转化"], description: "用 3 个利益点做一支短广告，结尾给出行动。", sample: "# 产品广告\n\n## 为什么值得看\n30 秒讲清一个真实使用场景。\n\n## 三个理由\n- 省时间\n- 可修改\n- 不绑模型" },
  { id: "store-opening", title: "门店开业", category: "本地生意", template: "explainer", tags: ["开业", "门店", "活动"], description: "开业时间、主打产品、到店理由，适合咖啡店/餐厅/小店。", sample: "# 咖啡店开业\n\n- 10 月 1 日开业，主打手冲和早餐\n- 前 50 位到店送一杯手冲\n- 地址：市中心老街 18 号\n\n欢迎来喝第一杯。" },
  { id: "ugc-recommend", title: "UGC 好物推荐", category: "社媒", template: "listicle", tags: ["UGC", "种草", "口播"], description: "第一人称推荐，先说痛点，再给使用感受和结论。", sample: "# 好物推荐\n\n## 痛点\n每天通勤找不到合适的包。\n\n## 使用感受\n轻、能装、肩带不勒。\n\n## 结论\n适合每天背，不适合装电脑。" },
  { id: "course-lecture", title: "课程讲解", category: "教育", template: "explainer", tags: ["课程", "讲解", "概念"], description: "概念定义、前提、例子、结论，适合一节课的核心片段。", sample: "# 熵与生命\n\n## 核心概念\n熵是微观排列方式的数量。\n\n## 例子\n咖啡和牛奶混匀后不会自己分开。\n\n## 结论\n孤立系统的熵只增不减。" },
  { id: "science-explainer", title: "科普解释", category: "教育", template: "explainer", tags: ["科普", "原理", "例子"], description: "用日常现象解释一个科学概念，避免公式堆砌。", sample: "# 为什么天空是蓝色的\n\n## 现象\n白天抬头看到蓝色。\n\n## 原理\n短波蓝光更容易被空气分子散射。\n\n## 结论\n日落时路径更长，蓝色被散射掉。" },
  { id: "data-brief", title: "数据速览", category: "数据", template: "listicle", tags: ["数据", "图表", "报告"], description: "先给结论，再给 3 个数字和口径，适合周报/月报。", sample: "# 本周数据速览\n\n## 结论\n新增用户环比上升。\n\n## 三个数字\n- 新增 1280\n- 留存 42%\n- 付费转化 3.1%" },
  { id: "paper-read", title: "论文解读", category: "研究", template: "paper", tags: ["论文", "方法", "结果"], description: "问题、方法、结果、限制四段，适合论文/报告解读。", sample: "# 一篇论文在说什么\n\n## 问题\n现有方法在长视频上不稳定。\n\n## 方法\n按镜头缓存，只重算改动部分。\n\n## 结果\n修改一镜耗时下降。\n\n## 限制\n跨机器仍需环境归因。" },
  { id: "how-to", title: "操作教程", category: "教育", template: "howto", tags: ["教程", "步骤", "操作"], description: "目标 + 三步操作 + 常见错误，适合软件/设备教学。", sample: "# 如何导出视频\n\n## 目标\n得到一支可交付的 MP4。\n\n## 步骤\n- 选择导出规格\n- 检查旁白与字幕\n- 点击生成并下载\n\n## 注意\n付费配音需要先确认。" },
  { id: "timeline", title: "项目时间线", category: "商业", template: "timeline", tags: ["时间线", "里程碑", "复盘"], description: "按时间顺序讲清阶段、转折和结果。", sample: "# 项目时间线\n\n## 3 月\n完成原型。\n\n## 6 月\n第一个真实用户。\n\n## 9 月\n交付检查上线。" },
  { id: "versus", title: "对比评测", category: "产品", template: "versus", tags: ["对比", "评测", "选择"], description: "两组方案并排比较，最后给出适用场景。", sample: "# 两种方案怎么选\n\n## 方案 A\n本地渲染，快，可控。\n\n## 方案 B\n云端生成，画面更写实。\n\n## 结论\n讲解选 A，写实镜头选 B。" },
  { id: "myth-fact", title: "误区辨析", category: "教育", template: "mythfact", tags: ["误区", "事实", "纠错"], description: "先说常见误区，再用事实纠正，适合科普/培训。", sample: "# 关于熵的误区\n\n## 误区\n熵就是脏乱。\n\n## 事实\n熵是微观排列方式的数量。\n\n## 结论\n整齐也可以熵很高。" },
  { id: "case-study", title: "案例复盘", category: "商业", template: "case-study", tags: ["案例", "复盘", "结果"], description: "背景、行动、结果、可复用经验。", sample: "# 一次活动复盘\n\n## 背景\n新店开业，预算有限。\n\n## 行动\n用短视频讲清到店理由。\n\n## 结果\n首周到店超预期。\n\n## 经验\n先讲利益，再讲品牌。" },
  { id: "problem-solution", title: "问题与方案", category: "商业", template: "problem-solution", tags: ["问题", "方案", "执行"], description: "把痛点、方案和执行路径讲清楚。", sample: "# 交付为什么总延期\n\n## 问题\n改动无法预测。\n\n## 方案\n先计划，再构建，最后验证。\n\n## 执行\n每镜可独立重算。" },
  { id: "code-walkthrough", title: "代码走读", category: "技术", template: "code-walkthrough", tags: ["代码", "架构", "走读"], description: "按文件/函数讲清一段代码的输入、处理和输出。", sample: "# 这段代码做了什么\n\n## 输入\n读取项目 JSON。\n\n## 处理\n按场景构建时间线。\n\n## 输出\n逐帧渲染计划。" },
  { id: "recap", title: "速览总结", category: "教育", template: "recap", tags: ["总结", "回顾", "要点"], description: "把长内容压缩成 3 个要点，适合课程/会议结尾。", sample: "# 今天记住三件事\n\n- 先计划再构建\n- 改动只走依赖\n- 产物要能验证" },
  { id: "brand-manifesto", title: "品牌宣言", category: "品牌", template: "explainer", tags: ["品牌", "宣言", "态度"], description: "用短句讲品牌相信什么、不做什么。", sample: "# 我们相信\n\n## 相信\n工具应该让人更清楚，而不是更忙。\n\n## 不做\n不伪造来源，不夸大能力。" },
  { id: "company-intro", title: "公司介绍", category: "品牌", template: "explainer", tags: ["公司", "介绍", "团队"], description: "我们是谁、解决什么问题、怎么合作。", sample: "# 关于我们\n\n## 我们是谁\n一支做本地优先视频工具的小团队。\n\n## 解决什么\n让资料变成可编辑的视频。\n\n## 怎么合作\n从一支草稿开始。" },
  { id: "event-promo", title: "活动预告", category: "本地生意", template: "timeline", tags: ["活动", "预告", "报名"], description: "时间、地点、亮点、报名方式。", sample: "# 周末分享会\n\n- 周六 14:00\n- 市中心图书馆\n- 主题：用 AI 做讲解视频\n- 扫码报名" },
  { id: "social-vertical", title: "竖屏社媒", category: "社媒", template: "listicle", tags: ["竖屏", "社媒", "短视频"], description: "9:16 竖屏，3 个要点，适合抖音/视频号/Reels。", sample: "# 三个省时间的习惯\n\n- 先写结论\n- 只改一镜\n- 导出前做检查" },
  { id: "english-explainer", title: "英文讲解", category: "教育", template: "explainer", tags: ["英文", "讲解", "双语"], description: "英文标题 + 短句解释，适合双语课程/产品介绍。", sample: "# The Uncertainty Principle\n\n## Idea\nYou cannot know position and momentum at the same time.\n\n## Why\nMeasurement disturbs the system." },
  { id: "interview-summary", title: "访谈摘要", category: "媒体", template: "faq", tags: ["访谈", "问答", "摘要"], description: "把访谈整理成 3 个问题和回答。", sample: "# 访谈摘要\n\n## 为什么做本地优先？\n因为素材和草稿应该留在用户手里。\n\n## 最难的部分？\n让改动可预测。" },
  { id: "ecommerce-detail", title: "电商详情", category: "产品", template: "listicle", tags: ["电商", "详情", "卖点"], description: "卖点、规格、使用场景、售后，适合商品页视频。", sample: "# 商品详情\n\n## 卖点\n轻量、耐用、可机洗。\n\n## 规格\n容量 18L，重量 420g。\n\n## 场景\n通勤、旅行、健身。" },
  { id: "knowledge-card", title: "知识卡片", category: "教育", template: "explainer", tags: ["知识", "卡片", "概念"], description: "一个概念、一个例子、一个边界。", sample: "# 什么是机会成本\n\n## 概念\n选择一个方案时放弃的最大收益。\n\n## 例子\n今晚写代码，就不能去看电影。\n\n## 边界\n只算下一优选择。" },
  { id: "keynote", title: "发布会 Keynote", category: "品牌", template: "explainer", tags: ["发布会", "Keynote", "叙事"], description: "问题、愿景、产品、证据、行动，适合发布会开场。", sample: "# 我们为什么做这件事\n\n## 问题\n视频制作仍然太慢、太不可控。\n\n## 愿景\n让每个人都能构建可验证的视频。\n\n## 行动\n从一支免费草稿开始。" },
];
const variants = [
  { id: "dark-tech", label: "深色科技", theme: "glint-dark", aspect: "16:9", durationSec: 15 },
  { id: "clean-course", label: "明亮课程", theme: "glint-light", aspect: "16:9", durationSec: 12 },
  { id: "editorial", label: "杂志叙事", theme: "cream-editorial", aspect: "16:9", durationSec: 18 },
  { id: "vertical-social", label: "竖屏社媒", theme: "bold-poster", aspect: "9:16", durationSec: 15 },
];
const recipes = bases.flatMap(base => variants.map(variant => ({
  id: `${base.id}-${variant.id}`,
  title: `${base.title} · ${variant.label}`,
  category: base.category,
  description: `${base.description} ${variant.label}版本，${variant.aspect === "9:16" ? "适合竖屏信息流" : "适合横屏讲解"}。`,
  template: base.template,
  theme: variant.theme,
  aspect: variant.aspect,
  durationSec: variant.durationSec,
  tags: [...base.tags, variant.label],
  sampleMode: "source",
  sample: base.sample,
})));
const output = path.resolve(import.meta.dirname, "..", "apps/web/src/recipe-catalog.json");
fs.writeFileSync(output, JSON.stringify({ version: 1, generatedAt: "2026-10-23", recipes }, null, 2) + "\n");
console.log(`wrote ${recipes.length} recipes → ${path.relative(process.cwd(), output)}`);
