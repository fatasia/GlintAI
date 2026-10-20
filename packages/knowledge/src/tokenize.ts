const TOKEN =
  /[a-zA-Z0-9]+|[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]+/g;

/**
 * Mixed-language tokenizer: latin words lowercased; han/kana/hangul runs
 * turned into bigrams (single char if the run has length 1). Punctuation
 * is dropped — it carries no retrieval signal.
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const match of text.toLowerCase().matchAll(TOKEN)) {
    const raw = match[0];
    if (!raw) continue;
    if (/^[a-z0-9]+$/.test(raw)) {
      tokens.push(raw);
      continue;
    }
    const chars = [...raw];
    if (chars.length === 1 && chars[0]) {
      tokens.push(chars[0]);
      continue;
    }
    for (let i = 0; i + 1 < chars.length; i++) {
      const a = chars[i];
      const b = chars[i + 1];
      if (a && b) tokens.push(a + b);
    }
  }
  return tokens;
}
