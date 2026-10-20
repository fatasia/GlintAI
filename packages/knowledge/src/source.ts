import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { loadMarkdown, type KnowledgeDocument } from "./markdown";
import { extractPdf } from "./pdf";
import { fetchSource, MAX_SOURCE_BYTES } from "./source-url";

export class SourceError extends Error {
  constructor(message: string) { super(message); this.name = "SourceError"; }
}
const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };
export function htmlToText(html: string): string {
  return html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<\/(p|div|section|article|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<(br|hr)\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")
    .replace(/&(?:#x[\da-f]+|#\d+|[a-z]+);/gi, (entity) => {
      if (entity.startsWith("&#")) {
        const hex = entity[2]?.toLowerCase() === "x";
        const n = parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
        return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : " ";
      }
      return ENTITIES[entity.toLowerCase()] ?? " ";
    }).replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** RFC4180-style quoted cells; preserve row/column relationships as JSON rows. */
export function csvToText(csv: string): string {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false, closed = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i]!;
    if (quoted) {
      if (c === '"' && csv[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else field += c;
    } else if (c === '"' && !field && !closed) quoted = true;
    else if (c === ",") { row.push(field); field = ""; closed = false; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && csv[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = ""; closed = false;
    } else {
      if (closed || c === '"') throw new SourceError("Malformed CSV quoting");
      field += c;
    }
  }
  if (quoted) throw new SourceError("Unclosed CSV quote");
  if (field || closed || row.length) { row.push(field); rows.push(row); }
  return rows.map((cells, i) => `${i === 0 ? "Columns" : `Row ${i}`}: ${JSON.stringify(cells)}`).join("\n");
}

export type SourceAdapter = (input: { bytes: Uint8Array; extension: string; signal: AbortSignal }) => Promise<string>;
export interface SourceOptions { signal?: AbortSignal; timeoutMs?: number; adapters?: Record<string, SourceAdapter>; httpsOnly?: boolean }
const OFFICE = new Set(["docx", "pptx", "xlsx"]);
const MEDIA = new Set(["png", "jpg", "jpeg", "webp", "gif", "svg", "mp3", "wav", "mp4", "mov", "webm", "m4a", "ogg"]);
const TEXT = new Set(["md", "markdown", "txt", "html", "htm", "json", "csv"]);
const MIME: Record<string, string> = { "text/plain": "txt", "text/markdown": "md", "text/html": "html", "application/json": "json", "text/csv": "csv", "application/pdf": "pdf" };

async function extract(bytes: Buffer, ext: string, signal: AbortSignal): Promise<string> {
  if (OFFICE.has(ext)) throw new SourceError(`${ext} adapter is not installed. Export to Markdown/CSV/text PDF using a trusted document tool first; Office binaries are never read as UTF-8.`);
  if (MEDIA.has(ext)) throw new SourceError("Media is not a knowledge transcript. Use image/audio assets in SceneScript; provide OCR/transcription text separately. No OCR or transcription model is configured.");
  if (ext === "pdf") {
    if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new SourceError("Invalid PDF signature");
    return extractPdf(bytes, signal);
  }
  if (!TEXT.has(ext)) throw new SourceError(`Unsupported source format: ${ext || "unknown"}. Use md/txt/html/pdf/json/csv.`);
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new SourceError("Text source must be valid UTF-8; binary input is not supported"); }
  if (/[\x00-\x08\x0b\x0e-\x1f\x7f]/.test(text) || /^(?:%PDF-|PK\x03\x04|GIF8[79]a|\x7fELF)/.test(text)) {
    throw new SourceError("Binary/control content is not a text source");
  }
  if (ext === "html" || ext === "htm") return htmlToText(text);
  if (ext === "json") {
    try { return JSON.stringify(JSON.parse(text), null, 2); }
    catch { throw new SourceError("Invalid JSON source"); }
  }
  if (ext === "csv") return csvToText(text);
  return text;
}

export async function readSourceText(input: { path?: string; url?: string }, options: SourceOptions = {}): Promise<string> {
  if ([input.path, input.url].filter((value) => value !== undefined).length !== 1) throw new SourceError("Provide exactly one path or url");
  if ([input.path, input.url].some((value) => value !== undefined && !value.trim())) throw new SourceError("Source input cannot be blank");
  const timeout = options.timeoutMs ?? 30_000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 300_000) throw new SourceError("timeoutMs must be 1..300000");
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
  signal.throwIfAborted();
  let bytes: Buffer, ext: string;
  if (input.url) {
    const fetched = await fetchSource(input.url, signal, 0, options.httpsOnly);
    bytes = fetched.bytes;
    ext = MIME[fetched.contentType] ?? "unsupported MIME";
  } else {
    const filePath = input.path!;
    ext = path.extname(filePath).slice(1).toLowerCase();
    const stat = await fs.stat(filePath).catch(() => { throw new SourceError(`Source file not found: ${filePath}`); });
    if (!stat.isFile()) throw new SourceError("Source must be a regular file");
    if (stat.size > MAX_SOURCE_BYTES) throw new SourceError("Source exceeds 10 MiB");
    // Stream with a hard cap: a file may grow after stat, so readFile is not bounded.
    const chunks: Buffer[] = [];
    let size = 0;
    const stream = createReadStream(filePath, { signal });
    try {
      for await (const chunk of stream) {
        signal.throwIfAborted();
        const buffer = chunk as Buffer;
        size += buffer.length;
        if (size > MAX_SOURCE_BYTES) throw new SourceError("Source exceeds 10 MiB");
        chunks.push(buffer);
      }
      bytes = Buffer.concat(chunks);
    } finally {
      stream.destroy();
    }
  }
  if (bytes.length > MAX_SOURCE_BYTES) throw new SourceError("Source exceeds 10 MiB");
  signal.throwIfAborted();
  const adapter = options.adapters?.[ext];
  const text = adapter ? await adapter({ bytes, extension: ext, signal }) : await extract(bytes, ext, signal);
  signal.throwIfAborted();
  if (!text.trim()) throw new SourceError("Source has no extractable text; scanned PDFs need separate OCR");
  if (Buffer.byteLength(text) > MAX_SOURCE_BYTES) throw new SourceError("Extracted text exceeds 10 MiB");
  return text;
}

export async function loadAnySource(input: { path?: string; url?: string }, options: SourceOptions & { docId?: string } = {}): Promise<KnowledgeDocument> {
  return loadMarkdown(await readSourceText(input, options), { docId: options.docId ?? "source" });
}
