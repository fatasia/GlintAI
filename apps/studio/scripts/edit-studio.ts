import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { imageEdit, VERSIONS_FILE, EDIT_PRESETS, type ImageEditOptions } from "./image-edit";
import { editCss, editBody, presetLabels } from "./edit-studio/view";

interface QueueItem { prompt: string; preset?: string; output: string; state: "pending" | "running" | "completed" | "failed"; taskId?: string; error?: string }
interface Queue { id: string; src: string; mask?: string; state: "running" | "failed" | "completed"; items: QueueItem[] }
const QUEUE = ".glint-edit-queue.json";
const safeJson = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");
const atomic = (file: string, v: unknown) => { const temp = `${file}.${randomUUID()}.tmp`; fs.writeFileSync(temp, JSON.stringify(v, null, 2)); fs.renameSync(temp, file); };

/** Local files only. Reject sibling-prefix tricks, symlinks, absolute paths and traversal. */
export function studioImage(root: string, name: unknown): string {
  if (typeof name !== "string" || !name || /[\\/:\0]/.test(name) || name === "." || name === ".." || !/\.(png|jpe?g|webp)$/i.test(name)) throw new Error("请选择工作区内的图片");
  const file = path.join(root, name);
  if (fs.lstatSync(file).isSymbolicLink() || path.dirname(fs.realpathSync(file)) !== fs.realpathSync(root) || !fs.statSync(file).isFile()) throw new Error("图片路径越界或文件不存在");
  return file;
}

export function startEditStudio(dir: string, port: number | undefined, apiKey = "", baseUrl = "", publicDns = false, dependencies: { edit?: typeof imageEdit } = {}) {
  const root = fs.realpathSync(dir), token = randomUUID(), controller = new AbortController();
  const queueFile = path.join(root, QUEUE), lockFile = `${queueFile}.lock`;
  const loadQueue = (): Queue | undefined => fs.existsSync(queueFile) ? JSON.parse(fs.readFileSync(queueFile, "utf8")) : undefined;
  let running: Promise<void> | undefined;
  function claim() {
    if (fs.existsSync(lockFile)) {
      const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
      try { process.kill(lock.pid, 0); throw new Error("另一个编辑台正在执行此工作区的队列"); }
      catch (e: any) { if (e.code !== "ESRCH") throw e; fs.unlinkSync(lockFile); }
    }
    const handle = fs.openSync(lockFile, "wx"); fs.writeFileSync(handle, JSON.stringify({ pid: process.pid })); fs.closeSync(handle);
  }
  const unlock = () => { if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile); };
  function run(queue: Queue) {
    queue.state = "running"; atomic(queueFile, queue);
    running = (async () => {
      try {
        for (const item of queue.items) {
          if (item.state === "completed") continue;
          const journalPath = `${path.join(root, item.output)}.task.json`;
          const journal = fs.existsSync(journalPath) ? JSON.parse(fs.readFileSync(journalPath, "utf8")) : undefined;
          if (journal && !journal.taskId) throw new Error("上次提交结果不确定。先在网关核对任务 ID,不能自动重交。");
          if (journal?.state === "completed" && fs.existsSync(path.join(root, item.output))) { item.state = "completed"; atomic(queueFile, queue); continue; }
          item.state = "running"; delete item.error; atomic(queueFile, queue);
          try {
            const result = await (dependencies.edit ?? imageEdit)({ src: studioImage(root, queue.src), out: path.join(root, item.output), prompt: item.prompt, mask: queue.mask ? path.join(root, queue.mask) : undefined, taskId: journal?.taskId, apiKey, baseUrl, publicDns, signal: controller.signal });
            item.taskId = result.taskId; item.state = "completed"; atomic(queueFile, queue);
          } catch (e) { item.state = "failed"; item.error = e instanceof Error ? e.message : String(e); throw e; }
        }
        queue.state = "completed";
      } catch (e) { queue.state = "failed"; const item = queue.items.find(i => i.state !== "completed"); if (item) { item.state = "failed"; item.error ??= e instanceof Error ? e.message : String(e); } }
      finally { atomic(queueFile, queue); unlock(); running = undefined; }
    })();
  }
  const source = fs.readFileSync(fileURLToPath(new URL("./edit-studio/runtime.ts", import.meta.url)), "utf8");
  const runtime = ts.transpileModule(source.replace("export function editRuntime", "function editRuntime"), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } }).outputText + "\neditRuntime();";
  const server = createServer(async (request, response) => {
    const json = (status: number, body: unknown) => response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }).end(JSON.stringify(body));
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const host = request.headers.host ?? "";
      if (!/^127\.0\.0\.1:\d+$/.test(host)) { json(403, { error: "Invalid host" }); return; }
      if (request.method === "POST") {
        if (request.headers["x-glint-token"] !== token || request.headers.origin && request.headers.origin !== `http://${host}`) { json(403, { error: "请从本地编辑台发起请求" }); return; }
        let body = "";
        for await (const chunk of request) { body += chunk; if (body.length > 12 * 1024 * 1024) { json(413, { error: "请求超过 12 MiB" }); return; } }
        const input = JSON.parse(body || "{}");
        if (url.pathname === "/api/queue" || url.pathname === "/api/edit") {
          if (!apiKey || !baseUrl) { json(400, { error: "配置 GLINT_MEDIA_BASE_URL / GLINT_MEDIA_API_KEY 后可生成修改" }); return; }
          studioImage(root, input.src);
          const items = input.items ?? [{ prompt: EDIT_PRESETS[input.preset] ?? input.prompt, preset: input.preset }];
          if (!Array.isArray(items) || !items.length || items.length > 12 || items.some(i => !i || typeof i.prompt !== "string" || !i.prompt.trim() || i.prompt.length > 10000)) throw new Error("队列需要 1–12 个有效编辑提示词");
          if (running || loadQueue()?.state !== "completed" && loadQueue()) throw new Error("先恢复或完成当前队列,不要重复提交");
          claim();
          try {
            const id = randomUUID(); let mask: string | undefined;
            if (input.mask !== undefined) {
              if (typeof input.mask !== "string" || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(input.mask)) throw new Error("蒙版必须为 PNG");
              const bytes = Buffer.from(input.mask.split(",")[1]!, "base64");
              if (bytes.length > 8 * 1024 * 1024 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("无效或过大的 PNG 蒙版");
              fs.mkdirSync(path.join(root, ".glint-masks"), { recursive: true }); mask = `.glint-masks/${id}.png`; fs.writeFileSync(path.join(root, mask), bytes, { flag: "wx" });
            }
            const queue: Queue = { id, src: input.src, mask, state: "running", items: items.map((i, n) => ({ prompt: i.prompt, preset: i.preset, output: `edit-${id}-${n + 1}.png`, state: "pending" })) };
            run(queue); json(202, { id }); return;
          } catch (e) { unlock(); throw e; }
        }
        if (url.pathname === "/api/queue/resume") {
          if (running) throw new Error("队列正在执行");
          if (!apiKey || !baseUrl) throw new Error("网关未配置");
          const queue = loadQueue(); if (!queue || queue.state === "completed") throw new Error("没有需要恢复的队列");
          claim(); run(queue); json(202, { id: queue.id }); return;
        }
        json(404, { error: "Unknown endpoint" }); return;
      }
      if (request.method !== "GET") { json(405, { error: "Method not allowed" }); return; }
      if (url.pathname === "/api/state") {
        const images = fs.readdirSync(root).filter(f => { try { studioImage(root, f); return true; } catch { return false; } });
        const queue = loadQueue();
        if (queue?.state === "running" && !fs.existsSync(lockFile)) queue.state = "failed";
        json(200, { images, versions: fs.existsSync(path.join(root, VERSIONS_FILE)) ? JSON.parse(fs.readFileSync(path.join(root, VERSIONS_FILE), "utf8")) : [], queue, canEdit: Boolean(apiKey && baseUrl) }); return;
      }
      if (url.pathname === "/" || url.pathname === "/index.html") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'" }).end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Glint 图片编辑台</title><style>${editCss}</style></head><body>${editBody}<script id="edit-data" type="application/json">${safeJson({ token, presets: EDIT_PRESETS, labels: presetLabels })}</script><script>${runtime}</script></body></html>`); return;
      }
      if (url.pathname.startsWith("/files/")) {
        const file = studioImage(root, decodeURIComponent(url.pathname.slice(7)));
        response.writeHead(200, { "content-type": path.extname(file).toLowerCase() === ".webp" ? "image/webp" : /\.jpe?g$/i.test(file) ? "image/jpeg" : "image/png", "x-content-type-options": "nosniff" }).end(fs.readFileSync(file)); return;
      }
      json(404, { error: "Not found" });
    } catch (e) { json(400, { error: e instanceof Error ? e.message : String(e) }); }
  });
  return new Promise<{ url: string; close(): Promise<void> }>((resolve, reject) => {
    server.once("error", reject); server.listen(port ?? 0, "127.0.0.1", () => {
      const address = server.address(), url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : port}`;
      console.log(`[glint] 编辑台:${url} (前台运行; Ctrl+C 保存任务并退出)`);
      resolve({ url, close: async () => { controller.abort(); await running; server.closeAllConnections(); await new Promise<void>((res, rej) => server.close(e => e ? rej(e) : res())); } });
    });
  });
}

export async function runEditStudio(args: string[]) {
  const read = (name: string) => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const dir = read("dir"); if (!dir) throw new Error("edit-studio requires --dir=<asset directory>");
  const server = await startEditStudio(dir, Number(read("port")) || undefined, process.env.GLINT_MEDIA_API_KEY, process.env.GLINT_MEDIA_BASE_URL, process.env.GLINT_MEDIA_PUBLIC_DNS === "1");
  await new Promise<void>(resolve => {
    const stop = () => { process.off("SIGINT", stop); process.off("SIGTERM", stop); void server.close().finally(resolve); };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
  });
}
