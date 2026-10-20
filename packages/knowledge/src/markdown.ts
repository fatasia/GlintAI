export interface KnowledgeChunk {
  id: string;
  docId: string;
  docTitle: string;
  index: number;
  headingPath: string[];
  text: string;
}

export interface KnowledgeDocument {
  id: string;
  title: string;
  chunks: KnowledgeChunk[];
}

export const DEFAULT_MAX_CHUNK_CHARS = 900;
export const DEFAULT_MIN_CHUNK_CHARS = 150;

export interface ChunkOptions {
  docId?: string;
  maxChars?: number;
  minChars?: number;
}

interface Section {
  headingPath: string[];
  text: string;
}

function collectSections(markdown: string): Section[] {
  const sections: Section[] = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let headings: string[] = [];
  let buffer: string[] = [];

  const flush = () => {
    const text = buffer.join("\n").trim();
    buffer = [];
    if (text) sections.push({ headingPath: [...headings], text });
  };

  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      const level = heading[1]!.length;
      if (level === 1) {
        // H1 is the document title (captured separately); it must not
        // repeat inside every chunk's heading path.
        headings = [];
      } else {
        // H1 is excluded from the stack, so a level-L heading lives at
        // index L-2; slice away anything at or below that level first.
        headings = headings.slice(0, level - 2);
        headings[level - 2] = heading[2]!;
        headings = headings.filter((h): h is string => Boolean(h));
      }
    } else {
      buffer.push(line);
    }
  }
  flush();
  return sections;
}

/** Splits overlong text at sentence boundaries (CJK and latin). */
function splitLongText(text: string, maxChars: number): string[] {
  const sentences = text.split(/(?<=[。！？!?；;\n])/);
  const pieces: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > maxChars) {
      pieces.push(current);
      current = "";
    }
    current += sentence;
  }
  if (current.trim()) pieces.push(current);
  return pieces;
}

export function loadMarkdown(
  markdown: string,
  options: ChunkOptions = {},
): KnowledgeDocument {
  const docId = options.docId ?? "doc";
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHUNK_CHARS;
  const minChars = options.minChars ?? DEFAULT_MIN_CHUNK_CHARS;

  const titleMatch = /^#\s+(.+?)\s*$/m.exec(markdown);
  const title = titleMatch?.[1] ?? "Untitled";

  const sections = collectSections(markdown);
  const chunks: KnowledgeChunk[] = [];

  interface Piece {
    headingPath: string[];
    text: string;
  }

  // Group pieces into chunks: merge tiny sections with their neighbours,
  // but flush at heading boundaries once big enough so a chunk never
  // needlessly spans sections.
  let current: Piece[] = [];
  let length = 0;
  const flush = () => {
    const first = current[0];
    if (!first) return;
    chunks.push({
      id: `${docId}#${chunks.length}`,
      docId,
      docTitle: title,
      index: chunks.length,
      headingPath: first.headingPath,
      text: current.map((piece) => piece.text).join("\n"),
    });
    current = [];
    length = 0;
  };

  for (const section of sections) {
    const split =
      section.text.length > maxChars
        ? splitLongText(section.text, maxChars)
        : [section.text];
    for (const text of split) {
      if (length > 0 && length + text.length > maxChars && length >= minChars) {
        flush();
      }
      current.push({ headingPath: section.headingPath, text });
      length += text.length;
    }
    // Heading boundary: a chunk ends here once it is big enough to
    // stand alone.
    if (length >= minChars) flush();
  }
  flush();

  return { id: docId, title, chunks };
}
