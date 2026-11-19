import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { JSDOM } from "jsdom";
import { DESIGN_LIMITS, checkDesignAbort, designError, escapeHtml, inlineJson } from "./design-export-contract.mjs";
import { deckScript, deckTransitionSheet, deckTransitionsJson, stepRevealInjection } from "./design-export-transitions.mjs";

export const EXPORT_CSP = "default-src 'none'; img-src data:; media-src data:; font-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
const mime = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", mp4: "video/mp4", mp3: "audio/mpeg", wav: "audio/wav" };
const defaults = ":root{--ink-2:#101017;--ink-3:#181821;--paper:#f6f3eb;--paper-dim:#d0cdc5;--muted:#a8a5a0;--line-2:#3b3b46;--accent:#d8ef79;--accent-ink:#15180e;--r-sm:8px;--r-md:14px;--font-ui:Arial,'Microsoft YaHei',sans-serif}html,body{margin:0}body{font-family:Arial,'Microsoft YaHei',sans-serif}";
export async function prepareDesign(document, { mediaAsset, signal } = {}) {
  const warnings = new Set(), assets = new Map();
  let totalAssets = 0, expandedBytes = 0;
  const warn = message => warnings.add(message);
  const boundedReference = value => { expandedBytes += Buffer.byteLength(value); if (expandedBytes > DESIGN_LIMITS.assetsBytes) throw designError("内联资源展开超过 64MB，请减少重复图片引用后导出。", 413); return value; };
  async function reference(raw) {
    checkDesignAbort(signal);
    const value = raw.trim();
    if (!value || value.startsWith("#")) return value;
    if (/^(?:file|javascript|vbscript):/i.test(value) || /^[a-z]:[\\/]|^\\\\/i.test(value)) throw designError("导出拒绝本机路径或可执行资源引用；请改为素材库资源。");
    if (value.includes("\\") || /(?:^|\/)\.\.(?:\/|$)|%2e|%2f|%5c/i.test(value)) throw designError("导出拒绝包含路径穿越的资源引用。");
    if (/^data:/i.test(value)) {
      if (/^data:image\/(png|jpeg|webp|gif);base64,[a-z\d+/=\s]+$/i.test(value)) return boundedReference(value);
      warn("已屏蔽非位图 data 资源（包括 SVG/HTML），避免主动内容与嵌套外链。"); return "";
    }
    const match = /^(?:\/api\/media\/assets\/|\.?\/?assets\/)([a-zA-Z0-9_-]{1,100}\.(png|jpe?g|webp|mp4|mp3|wav))$/.exec(value);
    if (!match) { warn(`未获取外部或非托管资源：${value.slice(0, 160)}。请先导入素材库。`); return ""; }
    const name = match[1];
    if (assets.has(name)) return boundedReference(assets.get(name).dataUrl);
    if (assets.size >= DESIGN_LIMITS.assets) throw designError("引用素材超过 100 个限制。", 413);
    const file = await mediaAsset?.(name);
    if (typeof file !== "string" || !path.isAbsolute(file)) throw designError(`素材 ${name} 不在服务管理的素材库中，请重新导入。`);
    const stat = await fs.lstat(file).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > DESIGN_LIMITS.assetBytes || totalAssets + stat.size > DESIGN_LIMITS.assetsBytes) throw designError(`素材 ${name} 不可读取、是链接或超过导出大小限制。`);
    const bytes = await fs.readFile(file);
    if (bytes.length !== stat.size) throw designError(`素材 ${name} 在导出时发生变化，请重试。`, 409);
    totalAssets += bytes.length;
    const dataUrl = `data:${mime[match[2]]};base64,${bytes.toString("base64")}`;
    assets.set(name, { bytes, dataUrl, hash: createHash("sha256").update(bytes).digest("hex") });
    return boundedReference(dataUrl);
  }
  async function css(source) {
    let result = source.replace(/@import\s+(?:url\([^)]*\)|[^;]*)(?:;|$)/gi, () => { warn("已屏蔽外部 CSS @import；请将样式内联后重试。"); return ""; });
    const matches = [...result.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi)];
    for (const match of matches.reverse()) {
      const next = await reference(match[1] ?? match[2] ?? match[3]);
      result = result.slice(0, match.index) + `url("${next.replace(/"/g, "%22")}")` + result.slice(match.index + match[0].length);
    }
    if (/\\|image-set\(/i.test(result)) { warn("已移除包含 CSS 转义或 image-set 的样式，避免资源引用绕过；请将它改为普通内联样式。"); return ""; }
    return result;
  }
  const pages = [];
  for (const page of document.pages) {
    checkDesignAbort(signal);
    const dom = new JSDOM(page.html), doc = dom.window.document;
    try {
      if (doc.querySelectorAll("*").length > 15_000) throw designError("单页 DOM 元素超过 15000，请精简页面后导出。", 413);
      const visibleText = [...doc.body.querySelectorAll("*")].filter(node => !["SCRIPT", "STYLE", "NOSCRIPT"].includes(node.tagName)).some(node => [...node.childNodes].some(child => child.nodeType === 3 && child.textContent.trim())) || [...doc.body.childNodes].some(node => node.nodeType === 3 && node.textContent.trim());
      if (!visibleText && !doc.querySelector("img,svg,canvas,video,script") && !/background|border/.test(page.html)) throw designError(`页面“${page.title}”为空白，请添加内容后导出。`);
      for (const node of doc.querySelectorAll("base,meta,link,iframe,frame,object,embed,portal,animate,animateMotion,animateTransform,set,foreignObject")) { warn("安全版导出移除了页面元数据、外部样式、嵌入内容或 SVG 主动内容；原始源码仍保留。"); node.remove(); }
      for (const script of doc.querySelectorAll("script")) {
        if (script.src || script.type === "module") { warn("安全版导出移除了外部/模块脚本；原始源码仍保留。"); script.remove(); }
        else warn("PNG/PDF/PPTX 仅捕获静态布局，不执行脚本；HTML 安全版保留内联原型交互。");
      }
      for (const node of doc.querySelectorAll("*")) {
        const pageTarget=node.getAttribute("data-design-page");
        if(pageTarget!==null){const target=document.pages.findIndex(page=>page.id===pageTarget);if(target>=0&&["A","BUTTON"].includes(node.tagName)){node.setAttribute("data-export-page",String(target));}else warn("页面跳转目标不存在或元素不支持跳转，请检查源码。");}
        for (const attr of [...node.attributes]) {
          const key = attr.name.toLowerCase();
          if (["srcdoc", "action", "formaction", "ping", "manifest", "nonce", "integrity"].includes(key)) { node.removeAttribute(attr.name); warn("安全版已禁用嵌套页面、表单提交和主动联网属性。"); }
          else if (key === "srcset") { node.removeAttribute(attr.name); warn("安全版仅使用图片 src，已移除 srcset。"); }
          else if (key === "style" || /url\s*\(/i.test(attr.value)) node.setAttribute(attr.name, await css(attr.value));
          else if (["src", "poster", "background", "href", "xlink:href", "data"].includes(key)) {
            const target = document.pages.findIndex(p => p.id === attr.value || `#${p.id}` === attr.value);
            if (node.tagName.toLowerCase() === "a" && target >= 0) { node.setAttribute("href", `#design-page-${target}`); node.setAttribute("data-export-page", String(target)); }
            else if (node.tagName.toLowerCase() === "a" && attr.value.startsWith("#")) continue;
            else node.setAttribute(attr.name, await reference(attr.value));
          }
        }
        if (node.tagName.toLowerCase() === "style") node.textContent = await css(node.textContent);
        if (node.tagName.toLowerCase() === "a") { node.removeAttribute("target"); node.removeAttribute("download"); }
      }
      const style = doc.createElement("style"); style.textContent = defaults; doc.head.prepend(style);
      const policy = doc.createElement("meta"); policy.httpEquiv = "Content-Security-Policy"; policy.content = EXPORT_CSP; doc.head.prepend(policy);
      const portable = dom.serialize();
      const freeze = doc.createElement("style");freeze.textContent="*{animation:none!important;transition:none!important}";doc.head.appendChild(freeze);
      for (const node of doc.querySelectorAll("script")) node.remove();
      for (const node of doc.querySelectorAll("*")) for (const attr of [...node.attributes]) if (/^on/i.test(attr.name)) node.removeAttribute(attr.name);
      pages.push({ ...page, portable, staticHtml: dom.serialize() });
    } finally { dom.window.close(); }
  }
  return { pages, assets, warnings };
}
export function designHtml(document, prepared) {
  const pages = prepared.pages.map(page => page.portable);
  const navigation = document.pages.map((page, i) => `<button type="button" data-page="${i}">${escapeHtml(page.title)}</button>`).join("");
  const bridge = `<script>document.addEventListener('click',function(e){var a=e.target.closest('[data-export-page]');if(a){e.preventDefault();parent.postMessage({type:'glint-design-page',page:Number(a.dataset.exportPage)},'*')}})</script>`;
  const bridged = pages.map(html => html.replace(/<\/body>/i, `${bridge}</body>`));
  const stepScripts = document.pages.map(page => page.stepReveal ? stepRevealInjection : "");
  const script = deckScript({ pagesJson: inlineJson(bridged), transitionsJson: deckTransitionsJson(document.pages), stepScriptsJson: inlineJson(stepScripts), initialIndex: Math.max(0, document.pages.findIndex(p => p.id === document.activePageId)), sourceJson: "JSON.parse(document.getElementById('design-source').textContent)" });
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none';style-src 'unsafe-inline';script-src 'unsafe-inline';frame-src about:;img-src data:;connect-src 'none';base-uri 'none'"><title>${escapeHtml(document.title)}</title><style>*{box-sizing:border-box}html,body{margin:0;height:100%;overflow:hidden}body{height:100dvh;display:grid;grid-template-rows:auto auto minmax(0,1fr);font:14px system-ui,'Microsoft YaHei',sans-serif;background:#f6f7f8;color:#24282e}nav{padding:10px 16px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;border-bottom:1px solid #dfe3e7}button{padding:7px 12px;border:1px solid transparent;border-radius:6px;background:transparent;color:#4d5661;font:inherit;cursor:pointer}button:hover{background:#e8ecf0}button:disabled{background:white;border-color:#cdd4dc;color:#18212d;cursor:default}button:focus-visible{outline:2px solid #3666af;outline-offset:2px}#source{margin-left:auto;border-color:#d4dae1;font-size:12px}iframe{display:block;width:100%;height:100%;min-height:0;border:0;background:white}.note{padding:6px 16px;color:#657080;font-size:12px;line-height:1.5}@media(max-width:480px){nav{padding:8px;gap:4px}.note{padding:6px 10px}button{padding:7px 9px}}</style><style>${deckTransitionSheet(document.pages)}</style><style>.deck-stage{position:relative;height:100%;min-height:0}.deck-stage iframe{position:absolute;inset:0;width:100%;height:100%;border:0;background:white}</style><style id="deck-motion"></style></head><body><nav>${navigation}<button id="source">下载原始工程源码</button></nav><div class="note">离线预览 · 页面交互可运行，表单不向外发送数据。</div><div id="stage" class="deck-stage"><iframe id="page" sandbox="allow-scripts" title="设计页面"></iframe></div><script id="design-source" type="application/json">${inlineJson(document)}</script><script>${script}</script></body></html>`;
}
