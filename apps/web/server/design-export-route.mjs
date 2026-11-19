import fs from "node:fs";
import path from "node:path";

const FILE_NAME = /^design-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.(html|png|pdf|pptx|zip)$/;
const TYPES = { html: "text/html; charset=utf-8", png: "image/png", pdf: "application/pdf", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", zip: "application/zip" };

export function createDesignExportRoute({ outputDir, mediaAsset, exporter } = {}) {
  let service;
  const load = () => service ??= exporter ? Promise.resolve(exporter)
    : import("./design-export.mjs").then(module => module.createDesignExporter({ outputDir, mediaAsset }));
  return async function handle(req, res, url, { readBody, sendJson }) {
    if (!url.pathname.startsWith("/api/design/")) return false;
    if (url.pathname === "/api/design/export") {
      if (req.method !== "POST") { sendJson(res, 405, { error: "请使用导出按钮提交设计。" }); return true; }
      const controller = new AbortController();
      const stop = () => { if (!res.writableEnded) controller.abort(); };
      res.once("close", stop);
      try {
        const body = JSON.parse(await readBody(req, controller.signal, 9 * 1024 * 1024));
        const result = await (await load()).run({ document: body.document, format: body.format, signal: controller.signal });
        if (!FILE_NAME.test(result.file)) throw new Error("Invalid export filename");
        if (!res.destroyed) sendJson(res, 200, { file: result.file, bytes: result.bytes, warnings: result.warnings,
          ...(result.editableElements === undefined ? {} : { editableElements: result.editableElements }) });
      } catch (error) {
        if (!res.destroyed) sendJson(res, error.status ?? 400, { error: error instanceof SyntaxError ? "设计数据无法读取，请重新导出。" : error.message ?? "设计导出失败，请重试。" });
      } finally { res.off("close", stop); }
      return true;
    }
    const match = url.pathname.match(/^\/api\/design\/exports\/([^/]+)$/);
    if (!match || !["GET", "HEAD"].includes(req.method) || !FILE_NAME.test(match[1])) {
      sendJson(res, 404, { error: "找不到这份导出文件。" }); return true;
    }
    const file = path.join(outputDir, match[1]);
    let stat;
    try { stat = fs.lstatSync(file); } catch { sendJson(res, 404, { error: "导出文件已不存在，请重新导出。" }); return true; }
    if (!stat.isFile() || stat.isSymbolicLink()) { sendJson(res, 404, { error: "找不到这份导出文件。" }); return true; }
    const format = match[1].split(".").at(-1);
    res.writeHead(200, { "content-type": TYPES[format], "content-length": stat.size,
      "content-disposition": `attachment; filename="${match[1]}"`, "cache-control": "no-store",
      "content-security-policy": "sandbox; default-src 'none'", "x-content-type-options": "nosniff" });
    if (req.method === "HEAD") res.end();
    else fs.createReadStream(file).on("error", () => res.destroy()).pipe(res);
    return true;
  };
}
