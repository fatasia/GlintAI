import { appFetch as fetch } from "./app-url";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { parseEditorProject } from "./editor-model";
import { detectQuickVideoMode, type QuickVideoMode } from "./input-intent";
import type { QuickVideoPreset } from "./QuickVideo";
import "./project-composer.css";

const SourceFileImport = lazy(() => import("./SourceFileImport").then(module => ({ default: module.SourceFileImport })));
const DRAFT = "glint:project-composer.v1", PENDING = "glint:project-compose-pending.v1";
type Input = { text: string; aspect: "16:9" | "9:16" | "1:1"; mode: "auto" | QuickVideoMode };
type Payload = { source?: string; idea?: string; aspect: Input["aspect"]; template: string; theme: string; engine: "heuristic" | "llm" };
export type ComposedWork = { project: ReturnType<typeof parseEditorProject>; source: string; generatedSource: boolean };
export type ComposeContext = { input: string; mode: QuickVideoMode; template: string; theme: string };
type Receipt = { requestId: string; payload: Payload; result?: ComposedWork };
const empty: Input = { text: "", aspect: "16:9", mode: "auto" };
function readInput(): Input {
  try {
    const value = JSON.parse(localStorage.getItem(DRAFT) ?? "null");
    return value && typeof value.text === "string" && value.text.length <= 12000 && ["16:9", "9:16", "1:1"].includes(value.aspect) && ["auto", "idea", "source"].includes(value.mode) ? value : empty;
  } catch { return empty; }
}
function readResult(value: unknown): ComposedWork {
  const item = value as Partial<ComposedWork>;
  if (!item || typeof item.source !== "string" || item.source.length > 12000 || typeof item.generatedSource !== "boolean") throw new Error("工程返回不完整，原请求已保留，请恢复结果或核对服务。");
  return { project: parseEditorProject(item.project), source: item.source, generatedSource: item.generatedSource };
}
function readReceipt(): { receipt: Receipt | null; error: string } {
  try {
    const raw = localStorage.getItem(PENDING); if (raw === null) return { receipt: null, error: "" };
    if (raw.length > 4 * 1024 * 1024) throw new Error();
    const value = JSON.parse(raw) as Receipt, p = value.payload;
    if (!/^[a-zA-Z0-9-]{8,80}$/.test(value.requestId) || !p || !["16:9", "9:16", "1:1"].includes(p.aspect) ||
      !["heuristic", "llm"].includes(p.engine) || typeof p.template !== "string" || typeof p.theme !== "string" ||
      [typeof p.source === "string", typeof p.idea === "string"].filter(Boolean).length !== 1 ||
      p.source !== undefined && (typeof p.source !== "string" || p.source.length > 12000) ||
      p.idea !== undefined && (typeof p.idea !== "string" || p.idea.length > 2000) ||
      Object.keys(p).some(key => !["source", "idea", "aspect", "template", "theme", "engine"].includes(key))) throw new Error();
    return { receipt: { requestId: value.requestId, payload: p, ...(value.result ? { result: readResult(value.result) } : {}) }, error: "" };
  } catch { return { receipt: null, error: "上次生成记录无法读取，未覆盖原记录。请先保留本机数据并核对。" }; }
}

/** Create the editable work first. Rendering belongs to the editor's export step. */
export function ProjectComposer({ disabled = false, preset, beforeCreate, onCreated, onOpenSettings, onBusyChange }: {
  disabled?: boolean; preset?: QuickVideoPreset; beforeCreate?(): () => void;
  onCreated?(work: ComposedWork, context: ComposeContext): void | boolean;
  onOpenSettings?(): void; onBusyChange?(busy: boolean): void;
}) {
  const [input, setInput] = useState(readInput), [initial] = useState(readReceipt);
  const [receipt, setReceipt] = useState<Receipt | null>(initial.receipt), [error, setError] = useState(initial.error);
  const [busy, setBusy] = useState(false), [configured, setConfigured] = useState<boolean | null>(null);
  const [importing, setImporting] = useState(false), [storageNotice, setStorageNotice] = useState("");
  const current = useRef(receipt), request = useRef<AbortController | null>(null), area = useRef<HTMLTextAreaElement>(null), composing = useRef(false), mounted = useRef(true), inFlight = useRef(false);
  const mode = input.mode === "auto" ? detectQuickVideoMode(input.text) : input.mode;
  const locked = disabled || busy;
  const update = (next: Input) => {
    setInput(next);
    try { localStorage.setItem(DRAFT, JSON.stringify(next)); setStorageNotice(""); }
    catch { setStorageNotice("输入暂未存到本机，离开前请复制保留。"); }
  };
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; request.current?.abort(); };
  }, []);
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  useEffect(() => {
    let controller: AbortController;
    const probe = () => {
      controller?.abort(); controller = new AbortController(); const active = controller;
      void fetch("/api/settings/llm", { signal: AbortSignal.any([active.signal, AbortSignal.timeout(4000)]) }).then(async response => {
        const value = response.ok ? await response.json() : null;
        if (!active.signal.aborted) setConfigured(value?.configured === true);
      }).catch(() => { if (!active.signal.aborted) setConfigured(false); });
    };
    probe(); window.addEventListener("glint:model-settings", probe);
    return () => { controller.abort(); window.removeEventListener("glint:model-settings", probe); };
  }, []);
  useEffect(() => { if (preset) { update({ text: preset.text, aspect: preset.aspect, mode: "auto" }); setError(initial.error); } }, [preset?.nonce]);
  const remember = (next: Receipt) => {
    const raw = JSON.stringify(next);
    localStorage.setItem(PENDING, raw);
    if (localStorage.getItem(PENDING) !== raw) throw new Error("生成请求记录写入未确认，未开始新任务。请检查本机存储。");
    current.current = next; setReceipt(next);
  };
  const open = (work: ComposedWork, active: Receipt) => {
    const p = active.payload;
    if (!onCreated || onCreated(work, { input: p.source ?? p.idea!, mode: p.idea !== undefined ? "idea" : "source", template: p.template, theme: p.theme }) === false)
      throw new Error("工程已生成，尚未打开；请先保存当前修改，再打开已生成工程。");
    // Do not remove a receipt another window replaced during acceptance.
    try { if (JSON.parse(localStorage.getItem(PENDING) ?? "null")?.requestId === active.requestId) localStorage.removeItem(PENDING); }
    catch { /* A stale receipt is safe to inspect on the next visit. */ }
    current.current = null; setReceipt(null); setError("");
  };
  const run = async (recover = false) => {
    if (locked || inFlight.current || composing.current || initial.error) return;
    let active = current.current;
    try {
      const verify = beforeCreate?.();
      if (!recover) {
        if (active) throw new Error("上次生成尚未确认，请先恢复原请求结果，不另开一项任务。");
        const text = input.text.trim();
        if (!text) { area.current?.focus(); throw new Error("先写创作要求，或添加一份资料。"); }
        if (mode === "idea" && configured !== true) throw new Error("先连接文本模型，或切换「已有资料」离线开始。");
        if (mode === "idea" && text.length > 2000) throw new Error("创作要求最多 2000 字；完整文案请选择已有资料。");
        if (mode === "source" && text.length < 20) throw new Error("已有资料至少 20 个字，请补充正文。");
        active = { requestId: crypto.randomUUID(), payload: { ...(mode === "idea" ? { idea: text } : { source: text }), aspect: input.aspect, template: preset?.template ?? "auto", theme: preset?.theme ?? "glint-dark", engine: mode === "idea" ? "llm" : "heuristic" } };
        remember(active);
      }
      if (!active) return;
      inFlight.current = true; setError(""); setBusy(true);
      if (active.result) { verify?.(); open(active.result, active); return; }
      const controller = new AbortController(); request.current = controller;
      const response = await fetch("/api/compose", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...active.payload, requestId: active.requestId }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]) });
      const body = await response.json();
      if (!response.ok) {
        if ([400, 413, 503].includes(response.status)) {
          // A known rejection did not create an editable work; let the description be corrected.
          if (JSON.parse(localStorage.getItem(PENDING) ?? "null")?.requestId === active.requestId) localStorage.removeItem(PENDING);
          current.current = null; if (mounted.current) setReceipt(null);
        }
        throw new Error(typeof body?.error === "string" ? body.error : "生成失败，请核对资料或模型连接。");
      }
      const work = readResult(body);
      if (!mounted.current) return;
      active = { ...active, result: work }; current.current = active; setReceipt(active);
      try { remember(active); } catch { setStorageNotice("工程结果尚未存到本机；原请求编号已保留，可恢复结果。"); }
      verify?.(); open(work, active);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "生成结果未确认，请恢复原请求。");
    } finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  };
  return <section className="project-composer" aria-label="快速成片" aria-busy={busy}>
    <div className="pc-box">
      <textarea ref={area} aria-label="快速成片资料" aria-describedby="project-composer-hint" maxLength={12000} rows={4} disabled={locked} value={input.text}
        placeholder="描述你想做的作品，或粘贴现成文案…"
        onChange={event => { update({ ...input, text: event.target.value }); setError(initial.error); }}
        onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); void run(Boolean(current.current)); } }} />
      <div className="pc-controls">
        <button type="button" className="pc-attach" aria-expanded={importing} disabled={locked} onClick={() => setImporting(value => !value)}>添加资料</button>
        <label><span className="g-sr">输入类型</span><select aria-label="输入类型" disabled={locked} value={input.mode} onChange={event => update({ ...input, mode: event.target.value as Input["mode"] })}><option value="auto">自动识别</option><option value="idea">创作要求</option><option value="source">已有资料</option></select></label>
        <label><span className="g-sr">画幅</span><select aria-label="快速成片画幅" disabled={locked} value={input.aspect} onChange={event => update({ ...input, aspect: event.target.value as Input["aspect"] })}><option value="16:9">16:9 横版</option><option value="9:16">9:16 竖版</option><option value="1:1">1:1 方形</option></select></label>
        <span className="pc-count">{input.text.length || ""}{input.text.length ? " 字" : ""}</span>
        <button type="button" className="pc-submit" disabled={locked || Boolean(initial.error) || !receipt && (!input.text.trim() || mode === "idea" && configured !== true)} onClick={() => void run(Boolean(receipt))}>{busy ? "正在生成工程…" : receipt?.result ? "打开已生成工程" : receipt ? "恢复生成结果" : "开始创作"}<span aria-hidden="true">↗</span></button>
      </div>
    </div>
    {importing && <div className="pc-import"><Suspense fallback={<p role="status">正在准备导入…</p>}><SourceFileImport replacesProject={false} onApply={text => {
      if (locked) return false;
      if (input.text.trim() && !window.confirm("用导入资料替换当前描述？尚未提交的原描述会被替换。")) return false;
      update({ ...input, text, mode: "source" }); setImporting(false); return true;
    }} /></Suspense></div>}
    <div className="pc-hint" id="project-composer-hint"><span aria-label="当前输入模式">{mode === "source" ? "已有资料 · 本机编排，不调用模型" : configured === null ? "正在检查模型连接…" : configured ? "创作要求 · 使用已连接的文本模型，可能计费" : "创作要求需要文本模型"}</span>{mode === "idea" && configured === false && onOpenSettings && <button type="button" onClick={onOpenSettings}>连接模型</button>}{configured === false && <button type="button" disabled={locked} onClick={() => {
      if (input.text.trim() && !window.confirm("用示例资料替换当前描述？尚未提交的原描述会被替换。")) return;
      update({ ...input, mode: "source", text: "# 一杯咖啡为什么会变凉\n\n## 先观察\n热咖啡放在桌上，温度会逐渐接近室温。\n\n## 再解释\n咖啡与周围空气交换能量，温度差会影响降温过程。\n\n## 做个实验\n每隔一分钟测一次咖啡温度，同时记录室温。" }); setError(initial.error);
    }}>用示例资料试试</button>}<span>生成后直接编辑，导出时再渲染。</span></div>
    {busy && <p className="pc-progress" role="status">正在整理内容和分镜。可以停留在这里等待，不必重复提交。</p>}
    {receipt && !busy && <p className="pc-recovery">{receipt.result ? "工程已生成，当前编辑区未被替换。保存现有修改后可直接打开，无需再次生成。" : "有一项结果待确认。恢复会复用原请求编号和原输入。"}</p>}
    {storageNotice && <p role="status" className="pc-recovery">{storageNotice}</p>}
    {error && <p role="alert" className="pc-error">{error}</p>}
  </section>;
}
