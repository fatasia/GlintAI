export const DESIGN_LIMITS = Object.freeze({ pageBytes: 2 * 1024 * 1024, totalBytes: 8 * 1024 * 1024, pages: 30, assetBytes: 32 * 1024 * 1024, assetsBytes: 64 * 1024 * 1024, assets: 100, timeout: 90_000 });
export function designError(message, status = 400) { return Object.assign(new Error(message), { status }); }
export function checkDesignAbort(signal) { if (signal?.aborted) throw designError("设计导出已取消，请重新导出。", 499); }
export function validateDesignRequest(request) {
  if (!request || !["html", "png", "pdf", "pptx", "zip"].includes(request.format)) throw designError("请选择 HTML、PNG、PDF、PPTX 或 ZIP 导出格式。");
  const doc = request.document;
  const text = (value, max, empty = false) => typeof value === "string" && value.length <= max && (empty || Boolean(value.trim())) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
  if (!doc || !text(doc.id, 200) || !text(doc.title, 500) || !["page", "prototype", "slides"].includes(doc.kind) || !Array.isArray(doc.pages) || doc.pages.length < 1 || doc.pages.length > DESIGN_LIMITS.pages || !Number.isFinite(doc.updatedAt) || doc.updatedAt < 0) throw designError("设计文档无效；需要标题、有效时间戳和 1–30 个页面。");
  const ids = new Set();
  for (const page of doc.pages) {
    if (!page || !text(page.id, 200) || ids.has(page.id) || !text(page.title, 500) || !text(page.html, DESIGN_LIMITS.pageBytes) || Buffer.byteLength(page.html) > DESIGN_LIMITS.pageBytes || (page.notes !== undefined && !text(page.notes, 50_000, true))) throw designError("设计页面无效、重复、空白或超过每页 2MB 限制。");
    ids.add(page.id);
  }
  if (!ids.has(doc.activePageId)) throw designError("当前页面不在设计文档中。");
  let bytes;
  try { bytes = Buffer.byteLength(JSON.stringify(doc)); } catch { throw designError("设计文档必须是可序列化数据。"); }
  if (bytes > DESIGN_LIMITS.totalBytes) throw designError("设计文档超过 8MB 总量限制。", 413);
  return { document: doc, format: request.format };
}
export const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
export const inlineJson = value => JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
