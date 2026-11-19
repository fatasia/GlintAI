import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { zipSync, strToU8 } from "fflate";
import { DESIGN_LIMITS, checkDesignAbort, designError, validateDesignRequest } from "./design-export-contract.mjs";
import { prepareDesign, designHtml } from "./design-export-html.mjs";
import { captureDesign } from "./design-export-browser.mjs";
import { editableDesignPptx } from "./design-export-pptx.mjs";

const OUTPUT_LIMIT = 128 * 1024 * 1024;
export function createDesignExporter({ outputDir, mediaAsset } = {}) {
  if (typeof outputDir !== "string" || !path.isAbsolute(outputDir)) throw designError("设计导出需要服务配置的绝对输出目录。", 500);
  let busy = false;
  return {
    async run(request) {
      const { document, format } = validateDesignRequest(request);
      if (busy) throw designError("已有设计正在导出，请稍后重试。", 429);
      busy = true;
      const timeout = AbortSignal.timeout(DESIGN_LIMITS.timeout);
      const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
      const id = `design-${randomUUID()}`, file = `${id}.${format}`;
      const temporary = path.join(outputDir, `.${id}.part`), target = path.join(outputDir, file);
      try {
        checkDesignAbort(signal);
        const prepared = await prepareDesign(document, { mediaAsset, signal });
        let buffer, editableElements;
        if (format === "html") buffer = Buffer.from(designHtml(document, prepared));
        else if (format === "zip") {
          const entries = { "index.html": strToU8(designHtml(document, prepared)), "document.json": strToU8(JSON.stringify(document, null, 2)) };
          document.pages.forEach((page, i) => { entries[`source/page-${i + 1}.html`] = strToU8(page.html); });
          prepared.pages.forEach((page, i) => { entries[`pages/page-${i + 1}.html`] = strToU8(page.portable); });
          for (const [name, asset] of prepared.assets) entries[`assets/${name}`] = asset.bytes;
          entries["export-manifest.json"] = strToU8(JSON.stringify({ version: 1, documentId: document.id, activePageId: document.activePageId, pages: document.pages.map((page, i) => ({ id: page.id, title: page.title, source: `source/page-${i + 1}.html`, portable: `pages/page-${i + 1}.html` })), assets: [...prepared.assets].map(([name, asset]) => ({ file: `assets/${name}`, bytes: asset.bytes.length, sha256: asset.hash })), warnings: [...prepared.warnings] }, null, 2));
          buffer = Buffer.from(zipSync(entries, { level: 6 }));
        } else {
          const captured = await captureDesign(prepared, document, format, { signal });
          if (format === "pptx") ({ buffer, editableElements } = await editableDesignPptx(document, prepared, captured.layouts, { signal }));
          else buffer = captured.buffer;
        }
        checkDesignAbort(signal);
        if (!buffer?.length || buffer.length > OUTPUT_LIMIT) throw designError("导出结果为空或超过 128MB，请减少页面/素材后重试。", 413);
        await fs.mkdir(outputDir, { recursive: true });
        const root = await fs.lstat(outputDir);
        if (!root.isDirectory() || root.isSymbolicLink()) throw designError("导出目录不可用或是符号链接，请检查服务配置。", 500);
        await fs.writeFile(temporary, buffer, { flag: "wx", mode: 0o600 });
        checkDesignAbort(signal);
        await fs.rename(temporary, target);
        return { file, bytes: buffer.length, path: target, warnings: [...prepared.warnings], ...(editableElements === undefined ? {} : { editableElements }) };
      } catch (error) {
        if (error.status) throw error;
        throw designError("设计导出失败，请检查素材与输出目录权限后重试。", 500);
      } finally {
        busy = false;
        await fs.rm(temporary, { force: true }).catch(error => { if (error.code !== "ENOENT") throw designError("导出临时文件清理失败，请检查输出目录权限。", 500); });
      }
    },
  };
}
