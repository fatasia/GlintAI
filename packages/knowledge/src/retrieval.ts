import type { KnowledgeChunk, KnowledgeDocument } from "./markdown";
import { tokenize } from "./tokenize";

export interface ScoredChunk {
  chunk: KnowledgeChunk;
  score: number;
}

export interface KnowledgeBase {
  addDocument(document: KnowledgeDocument): void;
  search(query: string, topK?: number): ScoredChunk[];
}

export interface AsyncKnowledgeBase {
  addDocument(document: KnowledgeDocument): void;
  searchAsync(query: string, topK?: number): Promise<ScoredChunk[]>;
}

const BM25_K1 = 1.2;
const BM25_B = 0.75;

interface IndexedChunk {
  chunk: KnowledgeChunk;
  termFreq: Map<string, number>;
  length: number;
}

/** Zero-dependency BM25 over chunks; CJK handled via bigram tokenization. */
export class LexicalKnowledgeBase implements KnowledgeBase {
  private entries: IndexedChunk[] = [];
  private docFreq = new Map<string, number>();

  addDocument(document: KnowledgeDocument): void {
    for (const chunk of document.chunks) {
      const termFreq = new Map<string, number>();
      for (const term of tokenize(chunk.text)) {
        termFreq.set(term, (termFreq.get(term) ?? 0) + 1);
      }
      for (const term of termFreq.keys()) {
        this.docFreq.set(term, (this.docFreq.get(term) ?? 0) + 1);
      }
      this.entries.push({
        chunk,
        termFreq,
        length: [...termFreq.values()].reduce((sum, count) => sum + count, 0),
      });
    }
  }

  search(query: string, topK = 5): ScoredChunk[] {
    const queryTerms = tokenize(query);
    if (queryTerms.length === 0 || this.entries.length === 0) return [];

    const totalLength = this.entries.reduce((sum, entry) => sum + entry.length, 0);
    const avgLength = totalLength / this.entries.length;
    const n = this.entries.length;

    const scored: ScoredChunk[] = [];
    for (const entry of this.entries) {
      let score = 0;
      for (const term of queryTerms) {
        const tf = entry.termFreq.get(term) ?? 0;
        if (tf === 0) continue;
        const df = this.docFreq.get(term) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        score +=
          (idf * tf * (BM25_K1 + 1)) /
          (tf + BM25_K1 * (1 - BM25_B + (BM25_B * entry.length) / avgLength));
      }
      if (score > 0) scored.push({ chunk: entry.chunk, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }
}

export type EmbedFn = (texts: string[]) => Promise<number[][]>;

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Vector store backed by a caller-supplied embedding function. Embeddings
 * are computed lazily on first search and appended incrementally as
 * documents are added.
 */
export class EmbeddingKnowledgeBase implements AsyncKnowledgeBase {
  private chunks: KnowledgeChunk[] = [];
  private vectors: number[][] = [];

  constructor(private readonly embed: EmbedFn) {}

  addDocument(document: KnowledgeDocument): void {
    this.chunks.push(...document.chunks);
  }

  async searchAsync(query: string, topK = 5): Promise<ScoredChunk[]> {
    if (this.chunks.length === 0) return [];
    if (this.vectors.length < this.chunks.length) {
      const pending = this.chunks.slice(this.vectors.length);
      const embeddings = await this.embed(pending.map((chunk) => chunk.text));
      this.vectors.push(...embeddings);
    }
    const [queryVector] = await this.embed([query]);
    if (!queryVector) return [];
    const scored: ScoredChunk[] = this.chunks.map((chunk, index) => ({
      chunk,
      score: cosine(queryVector, this.vectors[index] ?? []),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }
}
