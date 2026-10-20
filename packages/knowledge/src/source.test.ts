import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readSourceText, csvToText, loadAnySource } from "./source";
import { isPublicAddress } from "./source-url";
function textPdf(): Buffer {
  const content = "BT /F1 18 Tf 72 720 Td (Offline PDF text) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [i, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}
const dirs: string[] = [];
async function fixture(ext: string, body: string | Buffer) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "glint 中文 space "));
  dirs.push(dir);
  const file = path.join(dir, `资料.${ext}`);
  await fs.writeFile(file, body);
  return file;
}
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });
describe("source matrix", () => {
  it.each(["md", "txt", "markdown"])("reads %s with Chinese/spaces", async (ext) => {
    expect(await readSourceText({ path: await fixture(ext, "# 中文\n内容") })).toContain("内容");
  });
  it("extracts HTML and drops scripts/styles", async () => {
    const text = await readSourceText({ path: await fixture("html", '<h1>标题</h1><script>alert(1)</script><style>bad</style><p>&#x4e2d;&amp;</p>') });
    expect(text).toBe("标题\n中&");
  });
  it("preserves JSON structure", async () => { expect(await readSourceText({ path: await fixture("json", '{"中文":[1,2]}') })).toContain('"中文"'); });
  it("handles multiline CSV and escaped quotes", async () => {
    expect(await readSourceText({ path: await fixture("csv", 'name,note\r\n张三,"a\nb"\r\n李四,"say ""hi"""') })).toContain('Row 2: ["李四","say \\"hi\\""]');
  });
  it.each(["docx", "pptx", "xlsx"])("explicit missing adapter %s", async (ext) => { await expect(readSourceText({ path: await fixture(ext, Buffer.from([80,75,0,1])) })).rejects.toThrow("adapter is not installed"); });
  it.each(["png", "mp3", "mp4"])("does not claim understanding %s", async (ext) => { await expect(readSourceText({ path: await fixture(ext, "binary") })).rejects.toThrow("OCR/transcription"); });
  it.each(["exe", "zip"])("rejects unsupported %s", async (ext) => { await expect(readSourceText({ path: await fixture(ext, "binary") })).rejects.toThrow("Unsupported"); });
  it("rejects binary disguised as text", async () => { await expect(readSourceText({ path: await fixture("txt", Buffer.from([255,0])) })).rejects.toThrow("UTF-8"); });
  it("rejects empty text", async () => { await expect(readSourceText({ path: await fixture("md", "  ") })).rejects.toThrow("no extractable"); });
  it("rejects malformed JSON", async () => { await expect(readSourceText({ path: await fixture("json", "{" ) })).rejects.toThrow("Invalid JSON"); });
  it("rejects malformed CSV", () => { expect(() => csvToText('a,"b')).toThrow("Unclosed"); });
  it("rejects large files", async () => { await expect(readSourceText({ path: await fixture("txt", Buffer.alloc(10*1024*1024+1, 65)) })).rejects.toThrow("10 MiB"); });
  it("rejects invalid PDF", async () => { await expect(readSourceText({ path: await fixture("pdf", "not PDF") })).rejects.toThrow("signature"); });
  it("rejects ambiguous inputs", async () => { await expect(readSourceText({ path: "a", url: "https://example.com" })).rejects.toThrow("exactly one"); });
  it("honors pre-cancellation", async () => { await expect(readSourceText({ path: "a" }, { signal: AbortSignal.abort() })).rejects.toThrow(); });
  it.each(["file:///etc/passwd", "http://user:pass@example.com", "http://127.0.0.1", "http://[::1]", "http://169.254.169.254", "http://2130706433"])("blocks unsafe URL %s", async (url) => { await expect(readSourceText({ url })).rejects.toThrow(); });
  it.each(["10.0.0.1", "::ffff:127.0.0.1", "fc00::1", "2002:7f00:1::", "192.168.1.1", "100.64.0.1"])("rejects private address %s", (ip) => expect(isPublicAddress(ip)).toBe(false));
  it.each(["md", "txt", "html", "json", "csv"])("rejects control bytes in disguised %s", async (ext) => {
    await expect(readSourceText({ path: await fixture(ext, "hello\x01world") })).rejects.toThrow("Binary/control");
  });
  it("rejects PDF and GIF signatures disguised as text", async () => {
    for (const body of ["%PDF-1.4\npretend text", "GIF89apretend text"]) {
      await expect(readSourceText({ path: await fixture("txt", body) })).rejects.toThrow("Binary/control");
    }
  });
  it("rejects whitespace inputs, non-files and missing files", async () => {
    await expect(readSourceText({ path: "   " })).rejects.toThrow("blank");
    const file = await fixture("md", "hello");
    await expect(readSourceText({ path: path.dirname(file) })).rejects.toThrow("regular file");
    await expect(readSourceText({ path: file + ".missing" })).rejects.toThrow("not found");
  });
  it.each([0, -1, NaN, 1.5, 300001])("validates timeout %s", async (timeoutMs) => {
    await expect(readSourceText({ path: "unused" }, { timeoutMs })).rejects.toThrow("timeoutMs");
  });
  it("passes cancellation through the document loader", async () => {
    await expect(loadAnySource({ path: "unused" }, { signal: AbortSignal.abort() })).rejects.toThrow();
  });
  it("loads concurrent sources independently", async () => {
    const files = await Promise.all([fixture("md", "# First\nalpha"), fixture("txt", "# Second\nbeta")]);
    expect(await Promise.all(files.map((file) => readSourceText({ path: file })))).toEqual(["# First\nalpha", "# Second\nbeta"]);
  });
  it("accepts a UTF-8 BOM and uppercase extension", async () => {
    expect(await readSourceText({ path: await fixture("TXT", "\ufeff中文\n正文") })).toBe("中文\n正文");
  });
  it("extracts a real text PDF in the isolated worker", async () => {
    expect(await readSourceText({ path: await fixture("pdf", textPdf()) })).toContain("Offline PDF text");
  });
  it("does not retain PDF worker failures across retries", async () => {
    const file = await fixture("pdf", "%PDF-1.4\nmalformed");
    await expect(readSourceText({ path: file })).rejects.toThrow("PDF");
    await expect(readSourceText({ path: file }, { timeoutMs: 1 })).rejects.toThrow();
    expect(await readSourceText({ path: await fixture("txt", "recovered") })).toBe("recovered");
  });
  it("accepts public address", () => expect(isPublicAddress("8.8.8.8")).toBe(true));
});
