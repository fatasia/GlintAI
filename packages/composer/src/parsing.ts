export interface Section {
  heading: string;
  sentences: string[];
  listItems: string[];
  quotes: Array<{ text: string; attribution?: string }>;
  code?: { text: string; language?: string };
}
export function splitSentences(text: string): string[] {
  return text.split(/(?<=[。！？!?])\s*|(?<=\.)\s+(?=[A-Za-z\u3400-\u9fff])/u).map((s) => s.trim()).filter(Boolean);
}
export function detectLanguage(text: string): string {
  const cjk = text.match(/[\u3400-\u9fff]/g)?.length ?? 0;
  const latin = text.match(/[a-z]/gi)?.length ?? 0;
  return cjk / Math.max(1, cjk + latin) >= .15 ? "zh-CN" : "en-US";
}
export function slugify(text: string, fallback: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || fallback;
}
export function narration(parts: string[], limit = 110): string {
  const clean = parts.map((s) => s.trim()).filter(Boolean);
  const selected: string[] = [];
  for (const part of clean) {
    if (selected.join(" ").length + part.length + 1 > limit) break;
    selected.push(part);
  }
  return selected.join(" ") || clean[0]?.slice(0, limit) || "";
}
export function content(section: Section): string[] {
  return [...section.sentences, ...section.listItems, ...section.quotes.map((q) => q.text)];
}
export function parseMarkdown(markdown: string, forcedTitle?: string): { title: string; sections: Section[] } {
  let title = forcedTitle;
  const sections: Section[] = [];
  let current: Section = { heading: "", sentences: [], listItems: [], quotes: [] };
  let fence: { mark: string; language: string; lines: string[] } | undefined;
  let pendingQuote: Section["quotes"][number] | undefined;
  const push = () => { if (content(current).length || current.code) sections.push(current); };
  for (const raw of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    const marker = /^(`{3,}|~{3,})([^\s]*)/.exec(line);
    if (fence) {
      if (marker && marker[1]![0] === fence.mark[0] && marker[1]!.length >= fence.mark.length && !line.slice(marker[1]!.length).trim()) {
        current.code = { text: fence.lines.join("\n"), language: fence.language || undefined }; fence = undefined;
      } else fence.lines.push(raw);
      continue;
    }
    if (marker) {
      if (current.code) { push(); current = { heading: current.heading, sentences: [], listItems: [], quotes: [] }; }
      fence = { mark: marker[1]!, language: marker[2]!, lines: [] }; continue;
    }
    if (!line) { pendingQuote = undefined; continue; }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      if (heading[1] === "#" && !title) title = heading[2];
      else { push(); current = { heading: heading[2]!, sentences: [], listItems: [], quotes: [] }; }
      pendingQuote = undefined; continue;
    }
    const attribution = /^[—–]{1,2}\s*(.+)$/.exec(line);
    if (attribution && pendingQuote) { pendingQuote.attribution = attribution[1]; continue; }
    const quote = /^(?:>\s*|[“「"])(.*?)(?:[”」"])?$/.exec(line);
    if (quote) { pendingQuote = { text: quote[1]! }; current.quotes.push(pendingQuote); continue; }
    const item = /^(?:[-*•]|\d+[.、)])\s+(.+)$/.exec(line);
    if (item) current.listItems.push(item[1]!);
    else current.sentences.push(...splitSentences(line.replace(/[*`]/g, "")));
    pendingQuote = undefined;
  }
  if (fence) current.code = { text: fence.lines.join("\n"), language: fence.language || undefined };
  push();
  title ??= sections[0]?.heading || content(sections[0] ?? current)[0]?.slice(0, 24);
  return { title: title ?? "", sections: sections.map((s) => ({ ...s, heading: s.heading || title || "" })) };
}
