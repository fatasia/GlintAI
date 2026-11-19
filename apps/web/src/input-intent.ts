export type QuickVideoMode = "idea" | "source";

const SOURCE_LABEL = /^(?:已有资料|参考资料|原文|正文|文章|资料|source|article|reference(?:\s+material)?|provided\s+text)\s*[:：]?$/i;
const SOURCE_PREFIX = /^(?:已有资料|参考资料|原文|正文|文章|资料|source|article|reference(?:\s+material)?|provided\s+text)\s*[:：]/i;
const CHINESE_REQUEST = /^(?:请(?:帮我|帮忙)?|帮我|帮忙|我(?:想|要|希望)|能不能|能否|麻烦|做(?:一|个|条|成|关于)|制作(?!工艺|过程|流程|方法|步骤|的)|生成|介绍(?!了|的|信|人)|宣传(?!活动|资料|材料|工作)|讲清(?:楚)?|解释(?!了|的)|不要|别(?:用|加|做)|希望|需要(?:一|做|制作|生成)|高级(?:一点|一些|感|风|[，,。]|$))/;
const CHINESE_BRIEF = /^(?:做[^。！？.!?]*?(?:视频|宣传片?|介绍|动画|教程|短片)|(?:给|为)[^。！？.!?]*?(?:做|制作|生成|介绍|宣传)|把[^。！？.!?]*?(?:做成|制作成|改成|讲清|变成)|用[^。！？.!?]*?(?:讲清|解释|介绍|宣传)|(?:时长|画幅|风格|受众|要求|创作要求|视频要求|主题|语气|节奏)\s*[:：]|(?:风格|画面|质感)(?:要|高级|简洁)|\d+(?:\.\d+)?\s*秒(?:钟)?(?:$|的|[，,、\s]|竖屏|横屏|视频|宣传))/;
const ENGLISH_REQUEST = /^(?:(?:please\s+)?(?:help\s+me\b|make\b|create\b|produce\b|generate\b|introduce\b|promote\b|explain\b|write\b|turn\b|don't\b|do\s+not\b|avoid\b)|i(?:'d|\s+would)?\s+(?:want|like|need)\b|(?:duration|style|audience|tone|format|requirements?|brief|topic)\s*:|(?:a\s+)?\d+(?:\.\d+)?[\s-]*(?:second|sec|s)\b.*\b(?:video|ad|promo|portrait|landscape)\b)/i;
const SOURCE_PROSE = /[。！？.!?](?:\s|$)|^(?:这是|本文|本次|我们|该|这个)|(?:位于|开业|成立于|主打|营业时间|提供|采用|包括|发布了|支持|不再|只需|是指)|\b(?:is|are|was|were|has|have|offers?|provides?|opened|founded|includes?)\b/i;
const stripMarkup = (line: string) => line.trim().replace(/^(?:#{1,6}\s+|(?:[-*+•]|\d+[.)、])\s*)/, "").trim();

/** Conservative local intent detection. Formatting and length never enable a model.
 * Explicitly labelled source and ordinary prose remain offline; request verbs
 * are anchored to a brief line, not searched inside an article's sentences.
 */
export function detectQuickVideoMode(text: string): QuickVideoMode {
  const lines = text.split(/\r?\n/).map(stripMarkup).filter(Boolean);
  if (!lines.length) return "idea";
  if (SOURCE_LABEL.test(lines[0]!) || SOURCE_PREFIX.test(lines[0]!)) return "source";
  for (const line of lines) {
    if (SOURCE_LABEL.test(line) || SOURCE_PREFIX.test(line)) break;
    if (CHINESE_REQUEST.test(line) || CHINESE_BRIEF.test(line) || ENGLISH_REQUEST.test(line)) return "idea";
    // Once source prose begins, later quoted imperatives aren't user instructions.
    if (SOURCE_PROSE.test(line)) return "source";
  }
  return /^\s*(?:#{1,6}\s|[-*+•]\s|\d+[.)、]\s)/m.test(text) || SOURCE_PROSE.test(text) ? "source" : "idea";
}
