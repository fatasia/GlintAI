import { describe, expect, it } from "vitest";
import { loadMarkdown } from "./markdown";

describe("loadMarkdown", () => {
  it("extracts the H1 title and heading paths", () => {
    const doc = loadMarkdown(
      [
        "# 熵与生命",
        "",
        "## 什么是熵",
        "",
        "熵是混乱度的度量。",
        "",
        "## 生命与负熵",
        "",
        "生命以负熵为食。",
      ].join("\n"),
      // minChars 1: keep one chunk per section for assertion clarity.
      { docId: "entropy", minChars: 1 },
    );
    expect(doc.title).toBe("熵与生命");
    expect(doc.chunks.length).toBeGreaterThanOrEqual(2);
    const first = doc.chunks[0]!;
    expect(first.id).toBe("entropy#0");
    expect(first.headingPath).toEqual(["什么是熵"]);
    expect(first.text).toContain("混乱度");
    const last = doc.chunks[doc.chunks.length - 1]!;
    expect(last.headingPath).toEqual(["生命与负熵"]);
  });

  it("merges tiny sections and respects min/max chars", () => {
    const doc = loadMarkdown(
      [
        "# T",
        "",
        "## a",
        "短",
        "",
        "## b",
        "也很短",
        "",
        "## c",
        "还是短",
      ].join("\n"),
      { docId: "t", maxChars: 900, minChars: 10 },
    );
    // All three tiny sections merge into one chunk.
    expect(doc.chunks.length).toBe(1);
    expect(doc.chunks[0]!.text).toContain("短");
  });

  it("splits an overlong section at sentence boundaries", () => {
    const sentence = "这是一句足够长的话。";
    const body = sentence.repeat(60); // 600 chars, max 200 → multiple chunks
    const doc = loadMarkdown(`# Long\n\n${body}`, {
      docId: "long",
      maxChars: 200,
      minChars: 10,
    });
    expect(doc.chunks.length).toBeGreaterThan(1);
    for (const chunk of doc.chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(220);
    }
    // Chunk boundaries insert "\n"; content itself must survive intact.
    const joined = doc.chunks.map((c) => c.text).join("").replace(/\n/g, "");
    expect(joined).toBe(body);
  });

  it("handles CRLF line endings", () => {
    const doc = loadMarkdown("# T\r\n\r\n## S\r\n\r\n内容在这里。", { docId: "crlf" });
    expect(doc.title).toBe("T");
    expect(doc.chunks[0]!.headingPath).toEqual(["S"]);
  });

  it("returns a title-only document for empty input", () => {
    const doc = loadMarkdown("", { docId: "empty" });
    expect(doc.title).toBe("Untitled");
    expect(doc.chunks).toEqual([]);
  });
});
