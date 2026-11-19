import fs from "node:fs";
import path from "node:path";
import { archiveThemeBytes, listArchives, readArchive, sampleCatalog } from "../../studio/scripts/style-catalog.ts";
import { parseProject } from "@glintai/scenescript";

const ID = /^[a-f0-9-]{36}$/;
const reply = (res, status, value) => { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }); res.end(JSON.stringify(value)); };

/** The catalog serves only known, checked samples; history stores only theme data. */
export async function handleStyleCatalog(req, res, url, { sampleDir, historyDir, readBody }) {
  if (!url.pathname.startsWith("/api/style-catalog")) return false;
  try {
    if (req.method === "GET" && url.pathname === "/api/style-catalog/samples") {
      const entries = sampleCatalog(sampleDir).map(({ video, project, ...entry }) => ({ ...entry, ...(video && entry.status === "available" ? { url: `/api/style-catalog/samples/${entry.id}` } : {}) }));
      reply(res, 200, { entries }); return true;
    }
    const sample = url.pathname.match(/^\/api\/style-catalog\/samples\/([a-z0-9-]+)$/);
    if (req.method === "GET" && sample) {
      const item = sampleCatalog(sampleDir).find(entry => entry.id === sample[1]);
      if (!item || item.status !== "available" || !item.video) { reply(res, 404, { error: "样片不可用或校验不符。" }); return true; }
      const size = fs.statSync(item.video).size;
      const match = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
      if (req.headers.range && !match) { res.writeHead(416, { "content-range": `bytes */${size}` }); res.end(); return true; }
      const start = match ? Number(match[1]) : 0, end = match?.[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
      if (start >= size || end < start) { res.writeHead(416, { "content-range": `bytes */${size}` }); res.end(); return true; }
      res.writeHead(match ? 206 : 200, { "content-type": "video/mp4", "content-length": end - start + 1, "accept-ranges": "bytes", "cache-control": "no-store", "x-content-type-options": "nosniff", ...(match ? { "content-range": `bytes ${start}-${end}/${size}` } : {}) });
      fs.createReadStream(item.video, { start, end }).on("error", () => res.destroy()).pipe(res); return true;
    }
    if (req.method === "GET" && url.pathname === "/api/style-catalog/history") {
      const projectId = url.searchParams.get("projectId");
      if (!projectId) { reply(res, 400, { error: "缺少工程 ID。" }); return true; }
      const entries = listArchives(historyDir, projectId).map(({ file, ...entry }) => ({ ...entry, id: path.basename(file, ".style-history.json") }));
      reply(res, 200, { entries }); return true;
    }
    if (req.method === "POST" && url.pathname === "/api/style-catalog/history") {
      const text = await readBody(req, AbortSignal.timeout(10000), 2_000_000);
      const file = archiveThemeBytes(Buffer.from(text), historyDir);
      reply(res, 201, { id: path.basename(file, ".style-history.json") }); return true;
    }
    const restore = url.pathname.match(/^\/api\/style-catalog\/history\/([a-f0-9-]+)\/restore$/);
    if (req.method === "POST" && restore && ID.test(restore[1])) {
      const source = JSON.parse(await readBody(req, AbortSignal.timeout(10000), 2_000_000));
      const parsed = parseProject(source);
      const archive = readArchive(path.join(historyDir, `${restore[1]}.style-history.json`));
      if (archive.payload.projectId !== parsed.id) { reply(res, 409, { error: "版本不属于当前工程，未恢复。" }); return true; }
      if (archive.payload.themePresent) source.theme = structuredClone(archive.payload.theme); else delete source.theme;
      parseProject(source);
      reply(res, 200, { project: source }); return true;
    }
    reply(res, 404, { error: "未知的风格目录操作。" }); return true;
  } catch (error) {
    reply(res, error?.status === 413 ? 413 : 400, { error: error instanceof Error ? error.message : "风格目录操作失败，请重试。" }); return true;
  }
}
