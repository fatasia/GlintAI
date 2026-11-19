import { readDesignEntrance, patchDesignEntrance, type DesignEntrance } from "./design-animation";
import { DESIGN_HTML_LIMIT } from "./design-artifacts";
const safeId = /^[A-Za-z0-9_-]{1,100}$/;
const excluded = new Set(["SCRIPT", "STYLE", "LINK", "META", "NOSCRIPT", "TEMPLATE", "IFRAME", "OBJECT", "EMBED", "BASE"]);
export type DesignNode = { id: string; tagName: string; text: string; textEditable: boolean; locked: boolean; visible: boolean; style: Record<string, string>; pageTarget?:string; entrance?:DesignEntrance; entranceError?:string };
export type DesignLayer = DesignNode & { first: boolean; last: boolean; groupId?: string };
export type DesignLayerMove = "up" | "down" | "show" | "hide";
export type DesignAlign = "left" | "centerX" | "right" | "top" | "middleY" | "bottom" | "distributeX" | "distributeY";
export const designStyleProperties = ["fontSize", "fontFamily", "fontWeight", "lineHeight", "letterSpacing", "textAlign", "color", "backgroundColor", "left", "top", "width", "height", "position", "padding", "gap", "borderRadius", "boxShadow", "rotate"] as const;
export type DesignPatch = Partial<Record<"text" | typeof designStyleProperties[number], string>> & {
  locked?: boolean;
  pageTarget?:string;
  entrance?:DesignEntrance;
  /** Explicit target node; defaults to the caller's selection so a layer row can act on an unselected layer. */
  target?: string;
  /** Layer control: reorder among siblings or toggle inline visibility. */
  layer?: DesignLayerMove;
  /** Multi-selection layout; computed from inline left/top/width/height only. */
  align?: DesignAlign;
  group?: "group" | "ungroup";
};
const properties = designStyleProperties;
export function parseDesignHtml(html: string): Document {
  if (html.length > DESIGN_HTML_LIMIT) throw new Error("HTML 超过 1 MB，请精简后再导入。");
  const doc = new DOMParser().parseFromString(html, "text/html"); const used = new Set<string>(); let sequence = 0;
  for (const element of doc.body.querySelectorAll<HTMLElement>("*")) {
    if (excluded.has(element.tagName) || element.closest("svg,template")) { element.removeAttribute("data-design-id"); continue; }
    let id = element.getAttribute("data-design-id") ?? "";
    if (!safeId.test(id) || used.has(id)) { do { id = `design-node-${++sequence}`; } while (used.has(id) || doc.querySelector(`[data-design-id="${id}"]`)); }
    element.setAttribute("data-design-id", id); used.add(id);
  }
  return doc;
}
export const serializeDesignHtml = (doc: Document) => `<!doctype html>\n${doc.documentElement.outerHTML}`;
export const normalizeDesignHtml = (html: string) => serializeDesignHtml(parseDesignHtml(html));
export function designNodeElement(doc: Document, id: string): HTMLElement | null {
  return safeId.test(id) ? doc.body.querySelector<HTMLElement>(`[data-design-id="${id}"]`) : null;
}
export function describeDesignNode(html: string, id: string): DesignNode | undefined {
  const element = designNodeElement(parseDesignHtml(html), id); if (!element) return;
  let entrance:DesignEntrance|undefined,entranceError:string|undefined;try{entrance=readDesignEntrance(element);}catch(error){entranceError=error instanceof Error?error.message:"动画参数无法识别。";}
  return { id, entrance, entranceError, pageTarget:element.getAttribute("data-design-page")??(element.tagName==="A"?element.getAttribute("href")?.replace(/^#/,""):undefined)??undefined, tagName: element.tagName.toLowerCase(), text: element.textContent ?? "", textEditable: element.children.length === 0 && !["INPUT", "TEXTAREA", "SELECT", "IMG", "VIDEO", "AUDIO", "CANVAS"].includes(element.tagName),
    locked: Boolean(element.closest('[data-design-locked="true"]')), visible: element.style.display !== "none", style: Object.fromEntries(properties.map(key => [key, element.style[key]])) };
}
export function designLayers(html: string): DesignLayer[] {
  const doc = parseDesignHtml(html);
  return [...doc.body.querySelectorAll<HTMLElement>("[data-design-id]")].map(element => ({ id: element.dataset.designId!, tagName: element.tagName.toLowerCase(), text: (element.textContent ?? "").slice(0, 80), textEditable: element.children.length === 0, locked: Boolean(element.closest('[data-design-locked="true"]')), visible: element.style.display !== "none", first: !element.previousElementSibling, last: !element.nextElementSibling, groupId: element.dataset.designGroup, style: {} }));
}
function validStyle(key: string, value: string): boolean {
  if (value === "") return true;
  if (value.length > 300 || /[;{}<>\\]|url\s*\(|expression\s*\(/i.test(value)) return false;
  if (key === "position") return ["static", "relative", "absolute", "fixed", "sticky"].includes(value);
  if (key === "fontFamily") return /^[-\p{L}\p{N} _,'"]+$/u.test(value);
  if (key === "fontWeight") return /^(normal|bold|bolder|lighter|[1-9]\d{0,2}|1000)$/.test(value);
  if (key === "textAlign") return ["left", "right", "center", "justify", "start", "end"].includes(value);
  if (key === "rotate") return /^-?\d{1,3}(\.\d{1,2})?deg$/.test(value) && Math.abs(parseFloat(value)) <= 360;
  if (key === "lineHeight" && (value === "normal" || /^\d{1,2}(\.\d{1,2})?$/.test(value))) return true;
  if (key === "letterSpacing" && value === "normal") return true;
  if (["padding", "gap", "borderRadius"].includes(key)) {
    const tokens = value.trim().split(/\s+/), limit = key === "gap" ? 2 : 4;
    return tokens.length <= limit && tokens.every(token => token === "0" || /^\d{1,5}(\.\d{1,2})?(px|%|em|rem|vw|vh)$/.test(token));
  }
  if (key === "boxShadow") {
    if (value === "none") return true;
    // Collapse color functions before splitting multiple shadows; commas inside rgb() aren't separators.
    const shadows = value.replace(/(?:rgb|hsl)a?\([\d.% ,/+\-]+\)/gi, "#000").split(",");
    return shadows.length <= 4 && shadows.every(shadow => {
      const tokens = shadow.trim().split(/\s+/), lengths: string[] = [];
      let inset = false, color = false;
      for (const token of tokens) {
        if (token === "inset" && !inset) { inset = true; continue; }
        if (/^0$|^-?\d{1,5}(\.\d{1,2})?(px|em|rem|vw|vh)$/.test(token)) { lengths.push(token); continue; }
        if (!color && /^(#[\da-f]{3,8}|[a-z]+)$/i.test(token)) {
          const probe = document.createElement("span").style; probe.color = token;
          if (!probe.color) return false;
          color = true; continue;
        }
        return false;
      }
      return lengths.length >= 2 && lengths.length <= 4 && !(lengths[2]?.startsWith("-"));
    });
  }
  if (key === "color" || key === "backgroundColor") return value.length < 100 && !/[;{}<>]|url\s*\(|expression\s*\(/i.test(value) && /^(#[\da-f]{3,8}|[a-z]+|(?:rgb|hsl)a?\([\d.% ,/+\-]+\)|var\(--[\w-]+\))$/i.test(value);
  return /^-?\d{1,5}(\.\d{1,2})?(px|%|em|rem|vw|vh)$/.test(value) && (!['width', 'height', 'fontSize', 'lineHeight'].includes(key) || !value.startsWith("-"));
}
/** Reorders a layer among its element siblings; visibility keeps the inline display value for restore. */
function applyDesignLayerMove(element: HTMLElement, action: DesignLayerMove): boolean {
  if (action === "show" || action === "hide") {
    const hidden = element.style.display === "none";
    if (action === "hide") { if (hidden) return false; if (element.style.display) element.dataset.designDisplay = element.style.display; element.style.display = "none"; return true; }
    if (!hidden) return false;
    element.style.display = element.dataset.designDisplay ?? ""; delete element.dataset.designDisplay; return true;
  }
  const sibling = action === "up" ? element.previousElementSibling : element.nextElementSibling;
  if (!sibling || !element.parentElement) throw new Error(action === "up" ? "该图层已在最前，无法继续上移。" : "该图层已在最后，无法继续下移。");
  if (action === "up") element.parentElement.insertBefore(element, sibling); else element.parentElement.insertBefore(sibling, element);
  return true;
}
type DesignBox = { element: HTMLElement; start: number; size: number; unit: string };
function readLength(value: string): { value: number; unit: string } | undefined {
  const match = /^(-?\d{1,5}(?:\.\d{1,2})?)(px|%|em|rem|vw|vh)$/.exec(value.trim());
  return match ? { value: Number(match[1]), unit: match[2]! } : undefined;
}
/** Align/distribute reads only inline geometry: left/top plus width/height must be present and share one unit. */
function alignDesignNodes(doc: Document, ids: string[], mode: DesignAlign, html: string): string {
  const elements = [...new Set(ids)].map(id => { const element = designNodeElement(doc, id); if (!element) throw new Error("该节点不在静态源码中，不能对齐；请使用源码模式。"); return element; });
  const horizontal = mode === "left" || mode === "centerX" || mode === "right" || mode === "distributeX";
  const startKey = horizontal ? "left" : "top", sizeKey = horizontal ? "width" : "height";
  if (elements.length < 2) throw new Error("对齐需要至少两个图层。");
  if ((mode === "distributeX" || mode === "distributeY") && elements.length < 3) throw new Error("分布需要至少三个图层。");
  const boxes = elements.map(element => {
    const label = `<${element.tagName.toLowerCase()}>`;
    if (element.closest('[data-design-locked="true"]')) throw new Error(`图层 ${label} 已锁定，请先解锁再对齐。`);
    if (element.style.position === "static") throw new Error(`图层 ${label} 是 static 定位，${startKey} 不会生效；请先改为相对或绝对定位。`);
    const start = readLength(element.style[startKey]), size = readLength(element.style[sizeKey]);
    if (!start) throw new Error(`图层 ${label} 缺少内联 ${startKey}，无法确定几何位置；请先设置位置或在源码中调整。`);
    if (!size) throw new Error(`图层 ${label} 缺少内联 ${sizeKey}，无法确定几何尺寸；请先设置尺寸或在源码中调整。`);
    if (start.unit !== size.unit) throw new Error(`图层 ${label} 的 ${startKey} 与 ${sizeKey} 单位不一致，无法安全对齐。`);
    return { element, start: start.value, size: size.value, unit: start.unit };
  });
  const unit = boxes[0]!.unit;
  if (boxes.some(box => box.unit !== unit)) throw new Error("所选图层混用不同单位（如 px 与 %），无法安全对齐。");
  const positions = new Map<HTMLElement, number>();
  if (mode === "distributeX" || mode === "distributeY") {
    const sorted = [...boxes].sort((left, right) => left.start - right.start);
    const first = sorted[0]!, last = sorted[sorted.length - 1]!;
    const gap = ((last.start + last.size) - first.start - sorted.reduce((sum, box) => sum + box.size, 0)) / (sorted.length - 1);
    let cursor = first.start;
    for (const box of sorted) { positions.set(box.element, cursor); cursor += box.size + gap; }
  } else {
    const min = Math.min(...boxes.map(box => box.start)), max = Math.max(...boxes.map(box => box.start + box.size));
    for (const box of boxes) positions.set(box.element, mode === "left" || mode === "top" ? min : mode === "right" || mode === "bottom" ? max - box.size : (min + max) / 2 - box.size / 2);
  }
  let changed = false;
  for (const [element, value] of positions) {
    const next = `${Math.round(value * 100) / 100}${unit}`;
    if (element.style[startKey] === next) continue;
    element.style[startKey] = next; changed = true;
  }
  return changed ? serializeDesignHtml(doc) : html;
}
/** Only whitelisted text/style/data fields; never writes markup, handlers, scripts or selection HTML. Explicit layer actions on a locked layer throw; bulk selection patches keep the legacy skip. */
export function patchDesignNodes(html: string, ids: string[], patch: DesignPatch): string {
  const doc = parseDesignHtml(html);
  const targets = patch.target ? [patch.target] : [...new Set(ids)];
  if (patch.group) return groupDesignNodes(doc, targets, patch.group);
  if (patch.align) return alignDesignNodes(doc, targets, patch.align, html);
  let changed = false;
  for (const id of targets) {
    const element = designNodeElement(doc, id); if (!element) throw new Error("该节点不在静态源码中，不能属性编辑；请使用源码模式。");
    if (element.closest('[data-design-locked="true"]') && patch.locked !== false) {
      if (patch.target || patch.layer) throw new Error("图层已锁定，请先解锁再修改。");
      continue;
    }
    if (patch.locked !== undefined) { element.setAttribute("data-design-locked", String(patch.locked)); changed = true; }
    if(patch.pageTarget!==undefined){
      if(!["A","BUTTON"].includes(element.tagName))throw new Error("页面跳转只能设置在链接或按钮上。");
      if(patch.pageTarget.length>200||/[\u0000-\u001f]/.test(patch.pageTarget))throw new Error("目标页面编号无效。");
      if(patch.pageTarget){element.setAttribute("data-design-page",patch.pageTarget);if(element.tagName==="A")element.setAttribute("href",`#${patch.pageTarget}`);}
      else{element.removeAttribute("data-design-page");if(element.tagName==="A")element.removeAttribute("href");}
      changed=true;
    }
    if(patch.entrance){patchDesignEntrance(doc,element,patch.entrance);changed=true;}
    if (patch.layer) changed = applyDesignLayerMove(element, patch.layer) || changed;
    if (patch.text !== undefined) {
      if (element.children.length || ["INPUT", "TEXTAREA", "SELECT", "IMG", "CANVAS"].includes(element.tagName)) throw new Error("此元素包含子节点或运行态内容，请选择具体文字节点或编辑源码。");
      element.textContent = patch.text; changed = true;
    }
    for (const key of properties) if (patch[key] !== undefined) {
      const value = patch[key]!; if (!validStyle(key, value)) throw new Error("属性值无效；尺寸请使用 px、%、em 等单位，颜色请使用 CSS 颜色。");
      const cssName = key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
      // A rejected CSS assignment keeps the previous value. Validate on an empty
      // declaration so an existing style cannot disguise an invalid replacement.
      const probe = document.createElement("span").style; probe.setProperty(cssName, value);
      if (value && !probe.getPropertyValue(cssName)) throw new Error("浏览器不支持此属性值；未应用本次修改。");
      element.style.setProperty(cssName, value);
      changed = true;
    }
  }
  return changed ? serializeDesignHtml(doc) : html;
}
/** Logical groups preserve DOM order and CSS layout; no wrapper changes selectors or containing blocks. */
function groupDesignNodes(doc: Document, ids: string[], action: "group" | "ungroup"): string {
  const expanded = expandDesignGroupSelection(serializeDesignHtml(doc), ids);
  const elements = expanded.map(id => {
    const element = designNodeElement(doc, id);
    if (!element) throw new Error("所选图层已不存在，请重新选择。");
    if (element.closest('[data-design-locked="true"]')) throw new Error("组内存在锁定图层，请先解锁。");
    return element;
  });
  if (action === "group") {
    if (elements.length < 2) throw new Error("编组需要至少两个图层。");
    if (elements.length > 100) throw new Error("一组最多保留 100 个图层。");
    if (elements.some(element => element.parentElement !== elements[0]!.parentElement)) throw new Error("请选择同一父级的图层编组，避免嵌套位移。");
    let sequence = 1;
    const used = new Set([...doc.querySelectorAll<HTMLElement>('[data-design-group]')].map(element => element.dataset.designGroup));
    while (used.has(`group-${sequence}`)) sequence++;
    for (const element of elements) element.dataset.designGroup = `group-${sequence}`;
  } else for (const element of elements) delete element.dataset.designGroup;
  return serializeDesignHtml(doc);
}
export function expandDesignGroupSelection(html: string, ids: string[]): string[] {
  const doc = parseDesignHtml(html), selected = new Set(ids);
  const groups = new Set(ids.map(id => designNodeElement(doc, id)?.dataset.designGroup).filter(id => id && safeId.test(id)));
  for (const element of doc.querySelectorAll<HTMLElement>('[data-design-id][data-design-group]'))
    if (groups.has(element.dataset.designGroup)) selected.add(element.dataset.designId!);
  return [...selected];
}
export function applyDesignGesture(html: string, ids: string[], gesture: { dx: number; dy: number; width?: number; height?: number; rotation?: number }): string {
  let next = html;
  const targets = gesture.width === undefined && gesture.rotation === undefined ? expandDesignGroupSelection(html, ids) : ids;
  if(gesture.rotation!==undefined && (targets.length!==1 || !Number.isFinite(gesture.rotation) || Math.abs(gesture.rotation)>360))throw new Error("旋转需要选择单个元素，角度必须在 ±360° 内。");
  if (targets.some(id => describeDesignNode(html, id)?.locked)) throw new Error("所选图层或组内成员已锁定，移动未应用。");
  for (const id of targets) {
    const node = describeDesignNode(next, id); if (!node || node.locked) continue;
    const patch: DesignPatch = gesture.rotation !== undefined ? {rotate:`${Math.round(gesture.rotation*100)/100}deg`} : gesture.width === undefined ? {
      position: ["absolute", "fixed"].includes(node.style.position!) ? node.style.position : "relative",
      left: `${(parseFloat(node.style.left ?? "") || 0) + gesture.dx}px`, top: `${(parseFloat(node.style.top ?? "") || 0) + gesture.dy}px`,
    } : { width: `${Math.max(1, Math.round(gesture.width))}px`, height: `${Math.max(1, Math.round(gesture.height!))}px` };
    next = patchDesignNodes(next, [id], patch);
  }
  return next;
}
