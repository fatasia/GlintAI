// Portions derived from OpenMotion (nexu-io/openmotion) MCP Apps integration, Apache-2.0. Modifications: self-contained player shell, ≤8MiB data-URL transport, zh-CN.
import fs from "node:fs/promises";
import type { McpTool } from "./mcp";

/**
 * MCP Apps 协商面：支持 `text/html;profile=mcp-app` 的宿主获得内嵌成片播放器。
 * 形制照抄 OpenMotion：initialize 探测 capabilities.extensions 下的 ui mimeTypes，
 * tools/list 动态附加 show_video（_meta.ui.resourceUri 指向壳资源），壳经
 * resources/read 下发。传输差异：OpenMotion 的 App 通过 server-tool 直连取字节，
 * Glint 单进程 stdio 直接把 ≤8MiB 的成片编码为 data URL 内嵌（宿主信封截断风险
 * 与其一致——超过即拒绝，引导宿主用原生预览）。
 */

export const MCP_APP_MIME = "text/html;profile=mcp-app";
export const INLINE_PLAYER_URI = "glint://inline-player";
export const INLINE_VIDEO_LIMIT = 8 * 1024 * 1024;

/** Client declares MCP Apps support via capabilities.extensions["io.modelcontextprotocol/ui"].mimeTypes. */
export function isMcpAppClient(initializeParams: Record<string, unknown> | undefined): boolean {
  const capabilities = initializeParams?.capabilities as Record<string, unknown> | undefined;
  const extensions = capabilities?.extensions as Record<string, unknown> | undefined;
  const ui = extensions?.["io.modelcontextprotocol/ui"] as { mimeTypes?: unknown } | undefined;
  return Array.isArray(ui?.mimeTypes) && (ui!.mimeTypes as unknown[]).includes(MCP_APP_MIME);
}

/** Self-contained player shell: renders whatever src the host relays from the tool result. */
export function inlinePlayerResourceText(): string {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>Glint 成片</title><style>html,body{margin:0;height:100%;background:#0b0b10;color:#e6e6ee;font:14px/1.5 system-ui,sans-serif;display:grid;place-items:center}main{display:grid;gap:8px;max-width:100%;padding:12px}video{max-width:100%;max-height:82vh;border-radius:8px;background:#000}p{margin:0;color:#9a9aa8}</style></head><body><main><video controls playsinline hidden></video><p>等待成片数据…</p></main><script>(function(){'use strict';var video=document.querySelector('video'),hint=document.querySelector('p');function play(src,title){if(!src)return;video.src=src;if(title)document.title=title;video.hidden=false;hint.hidden=true;video.play().catch(function(){});}window.addEventListener('message',function(e){var d=e.data;if(!d||d.type!=='glint:video')return;play(d.src,d.title);});window.parent.postMessage({type:'glint:player-ready'},'*');})();</script></body></html>`;
}

const RESOURCE_META = {
  ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: ["data:", "blob:"] } },
  "openai/ui": { availableDisplayModes: ["inline"], preferredDisplayMode: "inline" },
};

export function inlinePlayerResource(): { uri: string; name: string; mimeType: string; description: string } {
  return { uri: INLINE_PLAYER_URI, name: "Glint 成片播放", mimeType: MCP_APP_MIME, description: "内嵌成片播放器壳；配合 glint_show_video 的结果由宿主渲染。" };
}

export function readInlinePlayerResource(uri: string): { uri: string; mimeType: string; text: string; _meta: typeof RESOURCE_META } | null {
  if (uri !== INLINE_PLAYER_URI) return null;
  return { uri, mimeType: MCP_APP_MIME, text: inlinePlayerResourceText(), _meta: RESOURCE_META };
}

/** Dynamic tool (negotiated clients only; deliberately outside the M-06d static registry). */
export function showVideoTool(): McpTool {
  return {
    name: "glint_show_video",
    description: "在支持 MCP Apps 的宿主里内嵌播放一段已完成的成片。输入本地视频文件路径（≤8MiB，如 glint_build 的 output）；只做展示，不渲染不修改工程。宿主有原生视频预览时优先用原生预览，不要对同一成片同时用两个播放器。",
    inputSchema: { type: "object", properties: { file: { type: "string", description: "本地 MP4/WebM 文件路径" }, title: { type: "string", description: "展示标题（可选）" } }, required: ["file"] },
    call: async args => {
      const file = typeof args.file === "string" ? args.file.trim() : "";
      if (!file) throw new Error("缺少 file 参数（本地视频路径）");
      const title = typeof args.title === "string" && args.title.trim() ? args.title.trim() : "Glint 成片";
      const stat = await fs.stat(file).catch(() => { throw new Error(`视频文件不存在或不可读：${file}`); });
      if (!stat.isFile()) throw new Error(`路径不是文件：${file}`);
      if (stat.size > INLINE_VIDEO_LIMIT) throw new Error(`视频超过内嵌上限 8MiB（实际 ${(stat.size / 1048576).toFixed(1)}MiB）；请在宿主原生预览或 Web 工作台播放，不要内嵌。`);
      const bytes = await fs.readFile(file);
      const src = `data:video/${/\.webm$/i.test(file) ? "webm" : "mp4"};base64,${bytes.toString("base64")}`;
      return { kind: "glint:video" as const, src, title };
    },
  };
}

/** Tool-result shape the host relays into the app iframe; shell listens for type:"glint:video". */
export function showVideoResultPayload(result: unknown): { content: Array<{ type: string; text: string }>; structuredContent: unknown; _meta: { ui: { resourceUri: string } } } {
  const presentation = result as { kind?: string; src?: string; title?: string };
  return {
    content: [{ type: "text", text: JSON.stringify({ kind: presentation.kind, title: presentation.title, bytes: presentation.src?.length ?? 0 }) }],
    structuredContent: presentation,
    _meta: { ui: { resourceUri: INLINE_PLAYER_URI } },
  };
}
