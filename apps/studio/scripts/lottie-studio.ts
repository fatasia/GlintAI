import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { inspectLottieScene, inspectLottieSource, runLottieImport } from "./lottie-import";

const fields = new Set(["speed", "scale", "opacity", "layer-index", "layer-text", "layer-opacity", "layer-anchor", "layer-pos", "layer-scale", "layer-rotation", "fill-path", "fill-color", "stroke-path", "stroke-color", "opacity-keyframe", "keyframe-opacity", "keyframe-frame", "position-keyframe", "keyframe-pos"]);
const maxBody = 16 * 1024;

export async function startLottieStudio(options: { project: string; scene: string; source?: string; port?: number }) {
  const project = fs.realpathSync(options.project);
  const source = options.source ? fs.realpathSync(options.source) : undefined;
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(options.scene)) throw new Error("镜头 ID 只能包含字母、数字、下划线和连字符。");
  // Validate before exposing the local entry. No animation or imported HTML is executed here.
  const inspect = () => source ? inspectLottieSource(source) : inspectLottieScene(project, options.scene);
  const snapshot = () => ({ project: fs.readFileSync(project), ...(source ? { source: fs.readFileSync(source) } : {}) });
  const fingerprint = (data = snapshot()) => createHash("sha256").update(data.project).update("\0").update(data.source ?? "").digest("hex");
  inspect();
  const token = randomBytes(32).toString("hex");
  const page = fs.readFileSync(fileURLToPath(new URL("./lottie-studio.html", import.meta.url)), "utf8");
  const server = createServer(async (req, res) => {
    const reply = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }).end(JSON.stringify(body));
    try {
      const host = req.headers.host ?? "";
      if (!/^127\.0\.0\.1:\d+$/.test(host) || (req.headers.origin && req.headers.origin !== `http://${host}`)) return reply(403, { error: "只允许本机编辑台访问。" });
      const url = new URL(req.url ?? "/", `http://${host}`);
      if (req.method === "GET" && url.pathname === "/") {
        return res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", "referrer-policy": "no-referrer" }).end(page);
      }
      if (req.headers["x-glint-token"] !== token) return reply(403, { error: "编辑会话已失效，请重新打开本地入口。" });
      if (req.method === "GET" && url.pathname === "/api/state") {
        const revision = fingerprint(), state = inspect();
        if (revision !== fingerprint()) return reply(409, { error: "工程或素材正在变化，请刷新后重试。" });
        return reply(200, { ...state, revision, mode: source ? "import" : "edit", scene: options.scene });
      }
      if (req.method !== "POST" || url.pathname !== "/api/save") return reply(404, { error: "未知操作。" });
      if (req.headers["content-type"] !== "application/json") return reply(415, { error: "请求格式无效。" });
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > maxBody) return reply(413, { error: "编辑内容过长。" }); chunks.push(bytes); }
      const data: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("编辑内容无效。");
      const { output, edits, revision } = data as Record<string, unknown>;
      const current = snapshot();
      if (typeof revision !== "string" || revision !== fingerprint(current)) return reply(409, { error: "工程或素材已被其他操作修改，请刷新后重新编辑。" });
      if (typeof output !== "string" || !/^[^\\/:*?"<>|\x00-\x1f]{1,120}\.json$/i.test(output) || output === ".json" || /[. ]$/.test(output.slice(0, -5))) throw new Error("请输入新工程文件名，例如 edited.json，不支持路径。");
      if (!edits || typeof edits !== "object" || Array.isArray(edits) || Object.entries(edits).some(([k, v]) => !fields.has(k) || typeof v !== "string" || v.length > 4096)) throw new Error("编辑参数无效。");
      const args = [`--project=${project}`, `--scene=${options.scene}`, `--out=${path.join(path.dirname(project), output)}`, ...(source ? ["--append", `--source=${source}`] : []), ...Object.entries(edits).map(([k, v]) => `--${k}=${v}`)];
      if (!source && Object.keys(edits).length === 0) throw new Error("请选择要修改的属性。");
      runLottieImport(args, current);
      return reply(200, { output });
    } catch (error) { return reply(400, { error: error instanceof Error ? error.message : "操作失败。" }); }
  });
  return await new Promise<{ url: string; close(): Promise<void> }>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("本地编辑台启动失败。"));
      resolve({ url: `http://127.0.0.1:${address.port}/#${token}`, close: () => new Promise((done, fail) => { server.closeAllConnections(); server.close(error => error ? fail(error) : done()); }) });
    });
  });
}

export async function runLottieStudio(args: string[]) {
  const get = (key: string) => args.find(arg => arg.startsWith(`--${key}=`))?.slice(key.length + 3);
  const project = get("project"), scene = get("scene"), source = get("source"), port = get("port");
  if (!project || !scene || (port !== undefined && (!/^\d+$/.test(port) || Number(port) > 65535))) throw new Error("用法：lottie-studio --project=工程.json --scene=镜头ID [--source=动画.json] [--port=端口]");
  const studio = await startLottieStudio({ project, scene, source, port: port === undefined ? undefined : Number(port) });
  console.log(`[glint] 本地编辑台：${studio.url}\n仅在本机使用；Ctrl+C 退出。编辑台不播放或执行动画。`);
  await new Promise<void>(resolve => {
    const stop = () => { process.off("SIGINT", stop); process.off("SIGTERM", stop); void studio.close().finally(resolve); };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
  });
}
