import { appFetch as fetch } from "./app-url";
import { projectAssetsKey } from "./design-asset-index";
import { DESIGN_HTML_LIMIT } from "./design-artifacts";
import { parseDesignHtml, serializeDesignHtml } from "./design-editor-dom";

// 512 KiB 编码后约 683 KiB，为 1 MiB 页面保留布局空间；整页仍需单独校验。
export const DESIGN_ASSET_BYTES = 512 * 1024;
export const DESIGN_LIBRARY_BYTES = 1024 * 1024;
const ACCEPTED = /^image\/(png|jpeg|webp|gif)$/;
const MEDIA_NAME = /^[a-zA-Z0-9_-]{1,100}\.(png|jpg|webp)$/;
const sizeError = () => new Error("图片超过 512 KiB，请先压缩再插入；整页 HTML（含 base64）最多 1 MiB。");

function imageDataUrl(src: string): void {
  const match = /^data:image\/(png|jpeg|webp|gif);base64,([a-zA-Z0-9+/]+={0,2})$/.exec(src);
  if (!match?.[2] || match[2].length % 4 !== 0) throw new Error("只支持 PNG、JPEG、WebP、GIF 的内联图片。");
  const bytes = match[2].length / 4 * 3 - (match[2].endsWith("==") ? 2 : match[2].endsWith("=") ? 1 : 0);
  if (bytes > DESIGN_ASSET_BYTES) throw sizeError();
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  if (!ACCEPTED.test(blob.type)) throw new Error("只支持 PNG、JPEG、WebP、GIF 图片。");
  if (blob.size > DESIGN_ASSET_BYTES) throw sizeError();
  if (!blob.size) throw new Error("图片为空，请选择有效图片。");
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        if (typeof reader.result !== "string") throw new Error("图片读取失败。");
        imageDataUrl(reader.result); resolve(reader.result);
      } catch (error) { reject(error); }
    };
    reader.onerror = () => reject(new Error("图片读取失败，请重试。"));
    reader.readAsDataURL(blob);
  });
}
export async function fileToDataUrl(file: File, optimize=false): Promise<string> {
 return blobToDataUrl(optimize&&file.size>DESIGN_ASSET_BYTES?await(await import("./design-image-optimize")).optimizeDesignImage(file):file);
}

// 只接受服务实际提供的媒体文件路径；不把同源的任意 API 当作图片下载器。
function mediaPath(raw: string): string {
  if (typeof raw !== "string" || raw.length > 2048 || /[\s\\%?#]/.test(raw) || raw.startsWith("//")) throw new Error("仅支持同源素材库图片地址。");
  const origin = globalThis.location?.origin;
  if (!origin || !/^https?:\/\//.test(origin)) throw new Error("素材来源不可验证，请改用本机图片。");
  const url = new URL(raw, origin);
  if (url.origin !== origin || url.username || url.password || !["http:", "https:"].includes(url.protocol)) throw new Error("仅支持同源素材库图片地址。");
  const match = /^\/(?:api\/media\/assets|assets)\/([^/]+)$/.exec(url.pathname);
  if (!match || !MEDIA_NAME.test(match[1]!) || (raw !== url.pathname && raw !== `${origin}${url.pathname}`)) throw new Error("仅支持同源素材库图片地址。");
  return url.pathname;
}

async function boundedBody(response: Response, max: number, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > max)) {
    await response.body?.cancel(); throw new Error(`素材响应超过 ${max / 1024} KiB 限制或长度无效。`);
  }
  if (!response.body) throw new Error("素材响应为空。");
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0, complete = false;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const chunk = await reader.read();
      signal?.throwIfAborted();
      if (chunk.done) { complete = true; break; }
      bytes += chunk.value.byteLength;
      if (bytes > max) throw new Error(`素材响应超过 ${max / 1024} KiB 限制。`);
      chunks.push(chunk.value);
    }
    if (length !== null && bytes !== Number(length)) throw new Error("素材响应长度不一致，请重新读取。");
    const data = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
    return data;
  } finally {
    signal?.removeEventListener("abort", abort);
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function urlToDataUrl(url: string, signal?: AbortSignal, optimize=false): Promise<string> {
  const path = mediaPath(url);
  const response = await fetch(path, { signal, mode: "same-origin", credentials: "same-origin", redirect: "error", referrerPolicy: "no-referrer" });
  if (!response.ok || response.redirected || (response.url && mediaPath(response.url) !== path)) { await response.body?.cancel(); throw new Error("素材读取失败；请确认文件仍在素材库。"); }
  const type = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  const expected = path.endsWith(".png") ? "image/png" : path.endsWith(".jpg") ? "image/jpeg" : "image/webp";
  if (type !== expected) { await response.body?.cancel(); throw new Error("该素材不是受支持的图片格式，或与文件名不一致。"); }
  const bytes = await boundedBody(response, optimize?8*1024*1024:DESIGN_ASSET_BYTES, signal);
  const blob=new Blob([bytes], { type });
  const result = await blobToDataUrl(optimize&&blob.size>DESIGN_ASSET_BYTES?await(await import("./design-image-optimize")).optimizeDesignImage(blob):blob);
  signal?.throwIfAborted();
  return result;
}

function imageHtml(doc: Document): string {
  const html = serializeDesignHtml(doc);
  if (html.length > DESIGN_HTML_LIMIT || new Blob([html]).size > DESIGN_HTML_LIMIT) throw new Error("插入后的 HTML 超过 1 MiB（含 base64），请压缩图片或减少页面内容。");
  return html;
}

const nextId = () => `image-${crypto.randomUUID().slice(0, 8)}`;
const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

/** Append a real, editable image block to the page (never inside a script-generated subtree). */
export function insertDesignImage(html: string, src: string, alt = "插入的图片"): { html: string; nodeId: string } {
  imageDataUrl(src);
  const doc = parseDesignHtml(html), host = doc.querySelector("main") ?? doc.body;
  if (host.closest('[data-design-locked="true"]')) throw new Error("插入位置已锁定，请先解锁再添加图片。");
  let id = nextId();
  while (doc.querySelector(`[data-design-id="${id}"], [data-design-id="${id}-frame"]`)) id = nextId();
  const figure = doc.createElement("figure");
  figure.setAttribute("data-design-id", `${id}-frame`);
  figure.setAttribute("style", "margin:24px 0;padding:0");
  const image = doc.createElement("img");
  image.setAttribute("data-design-id", id);
  image.setAttribute("src", src);
  image.setAttribute("alt", alt);
  image.setAttribute("style", "display:block;width:100%;height:auto;border-radius:12px");
  figure.appendChild(image);
  host.appendChild(figure);
  return { html: imageHtml(doc), nodeId: id };
}

/** Replace the picture behind the selected image node, keeping its layout and attributes. */
export function replaceDesignImage(html: string, nodeId: string, src: string): string {
  const doc = parseDesignHtml(html);
  const node = [...doc.querySelectorAll<HTMLElement>("[data-design-id]")].find(element => element.getAttribute("data-design-id") === nodeId);
  if (!node) throw new Error("选中的图片已不存在，请重新选择。");
  if (node.closest('[data-design-locked="true"]')) throw new Error("图层已锁定，请先解锁再替换图片。");
  const image = node.tagName === "IMG" ? node : node.querySelector("img");
  if (!image) throw new Error("请选中一张图片，或图片所在的卡片。");
  imageDataUrl(src);
  image.setAttribute("src", src);
  return imageHtml(doc);
}

export type LibraryAsset = { name: string; url: string; bytes: number };
function libraryAsset(value: unknown,maxBytes=DESIGN_ASSET_BYTES): LibraryAsset | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const asset = value as Partial<LibraryAsset>;
  if (typeof asset.name !== "string" || !MEDIA_NAME.test(asset.name) || typeof asset.url !== "string" || !Number.isSafeInteger(asset.bytes) || asset.bytes! < 1 || asset.bytes! > maxBytes) return null;
  try {
    const url = mediaPath(asset.url);
    if (url.split("/").at(-1) !== asset.name) return null;
    return { name: asset.name, url, bytes: asset.bytes! };
  } catch { return null; }
}
export async function readLibrary(signal?: AbortSignal, includeLarge=false): Promise<LibraryAsset[]> {
  const response = await fetch("/api/media/library", { signal, mode: "same-origin", credentials: "same-origin", redirect: "error" });
  if (!response.ok || response.redirected || (response.url && response.url !== `${globalThis.location?.origin}/api/media/library`)) { await response.body?.cancel(); throw new Error("素材库读取失败；可以改用本机图片。"); }
  if (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") { await response.body?.cancel(); throw new Error("素材库响应格式无效。"); }
  const bytes = await boundedBody(response, DESIGN_LIBRARY_BYTES, signal);
  let data: { assets?: unknown } | null;
  try { data = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error("素材库响应格式无效。"); }
  if (!data || !Array.isArray(data.assets) || data.assets.length > 5000) throw new Error("素材库列表无效或超过 5000 项限制。");
  return data.assets.flatMap((item: unknown) => { const asset = libraryAsset(item,includeLarge?8*1024*1024:DESIGN_ASSET_BYTES); return asset ? [asset] : []; });
}

export const assetAlt = (name: string) => name.replace(/\.[a-z0-9]+$/i, "").slice(0, 120) || "素材图片";
export { escape as escapeDesignText };

/** Per-project recency list: files still live in the shared media root, but the project remembers its own picks. */
export { projectAssetsKey, readProjectAssetsStrict } from "./design-asset-index";
export function readProjectAssets(projectId: string): LibraryAsset[] {
  try {
    const stored = localStorage.getItem(projectAssetsKey(projectId)) ?? "[]";
    if (stored.length > 128 * 1024) return [];
    const raw: unknown = JSON.parse(stored);
    if (!Array.isArray(raw) || raw.length > 40) return [];
    return raw.flatMap((item: unknown) => { const asset = libraryAsset(item); return asset ? [asset] : []; });
  } catch { return []; }
}
export function rememberProjectAsset(projectId: string, asset: LibraryAsset): LibraryAsset[] {
  const valid = libraryAsset(asset);
  if (!valid) throw new Error("素材引用无效；仅支持大小有效的同源素材库图片。");
  const next = [valid, ...readProjectAssets(projectId).filter(item => item.name !== valid.name)].slice(0, 40);
  try { localStorage.setItem(projectAssetsKey(projectId), JSON.stringify(next)); } catch { /* quota: the pick still works for this session */ }
  return next;
}
