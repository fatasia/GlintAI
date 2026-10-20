import { describe, expect, it } from "vitest";
import { loadMarkdown } from "./markdown";
import { tokenize } from "./tokenize";
import {
  EmbeddingKnowledgeBase,
  LexicalKnowledgeBase,
  cosine,
} from "./retrieval";

describe("tokenize", () => {
  it("splits latin words and lowercases them", () => {
    expect(tokenize("Entropy increases")).toEqual(["entropy", "increases"]);
  });

  it("makes bigrams from han runs", () => {
    expect(tokenize("熵增原理")).toEqual(["熵增", "增原", "原理"]);
  });

  it("makes bigrams from hangul runs so Korean text is retrievable", () => {
    const tokens = tokenize("한국어 텍스트");
    expect(tokens).toEqual(["한국", "국어", "텍스", "스트"]);
    expect(tokens).toContain(tokenize("한국")[0]!);
  });
});

const CORPUS = [
  "# 熵",
  "",
  "## 定义",
  "",
  "熵是热力学系统中混乱程度的度量,熵增原理说明孤立系统的熵永不减少。",
  "",
  "## 生命",
  "",
  "薛定谔提出生命以负熵为食,生物通过消耗能量维持自身的有序结构。",
  "",
  "## 黑洞",
  "",
  "黑洞熵与视界面积成正比,这是霍金提出的著名结论。",
].join("\n");

describe("LexicalKnowledgeBase", () => {
  const kb = new LexicalKnowledgeBase();
  // minChars 10 keeps one chunk per section so topic ranking is observable.
  kb.addDocument(loadMarkdown(CORPUS, { docId: "physics", minChars: 10 }));

  it("ranks the relevant chunk first for CJK queries", () => {
    const hits = kb.search("熵增原理是什么", 3);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.chunk.headingPath).toEqual(["定义"]);
  });

  it("finds chunks by distinct topics", () => {
    expect(kb.search("黑洞", 1)[0]!.chunk.headingPath).toEqual(["黑洞"]);
    expect(kb.search("生命以负熵为食", 1)[0]!.chunk.headingPath).toEqual(["生命"]);
  });

  it("returns nothing when the query shares no vocabulary", () => {
    expect(kb.search("量子 colour superposition 完全无关词")).toEqual([]);
    expect(kb.search("。。。")).toEqual([]);
  });

  it("respects topK", () => {
    expect(kb.search("熵 混乱 生命 黑洞", 2).length).toBeLessThanOrEqual(2);
  });

  it("is empty-safe", () => {
    const empty = new LexicalKnowledgeBase();
    expect(empty.search("熵")).toEqual([]);
  });
});

describe("EmbeddingKnowledgeBase", () => {
  // Deterministic fake embedding: 32-dim character-bigram hashing.
  const embed = async (texts: string[]) =>
    texts.map((text) => {
      const vector = new Array<number>(32).fill(0);
      const lower = text.toLowerCase();
      for (let i = 0; i < lower.length - 1; i++) {
        const bigram = lower.slice(i, i + 2);
        let hash = 0;
        for (const ch of bigram) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
        vector[hash % 32]! += 1;
      }
      return vector;
    });

  it("ranks relevant chunks first and stays lazy/incremental", async () => {
    const kb = new EmbeddingKnowledgeBase(embed);
    expect(await kb.searchAsync("熵增", 3)).toEqual([]);

    const doc = loadMarkdown(CORPUS, { docId: "physics", minChars: 10 });
    kb.addDocument(doc);
    const hits = await kb.searchAsync("熵是混乱程度的度量", 3);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.chunk.headingPath).toEqual(["定义"]);
  });
});

describe("cosine", () => {
  it("computes 1 for identical, 0 for orthogonal vectors", () => {
    expect(cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });
});
