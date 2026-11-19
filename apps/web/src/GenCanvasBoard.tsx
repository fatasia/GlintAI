import { applicationUrl } from "./app-url"; import { supportsMediaCapability } from "@glintai/models";
import { appFetch as fetch } from "./app-url";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { addGenNode, emptyGenCanvas, linkGenNodes, parseGenCanvas, removeGenNode, resolveGenPrompt, runnableGenNodes, type GenCanvas, type GenNode, type GenNodeKind } from "@glintai/scenescript/gen-canvas";
import { GenerationSurface } from "./GenerationSurface";
import { readGenerationLayout } from "./gen-canvas-layout";
import { Handle, Position } from "@xyflow/react";
import { field, select, button, label as fieldLabel, heading, sub, card, alert, colors } from "./ui-tokens";
import { downloadJson } from "./editor-model";

const KIND_LABEL: Record<GenNodeKind, string> = { text: "文本", image: "图片", video: "视频", audio: "音频" };
const KIND_HUE: Record<GenNodeKind, string> = { text: "#a09aae", image: "#9b8bfb", video: "#5eead4", audio: "var(--warn)" };
const NODE_W = 210, GAP_X = 260, GAP_Y = 132;

type Pos = { x: number; y: number };
type Model = { id: string; name?: string; tags?: string[] };
type Receipt = { requestId: string; nodeCreatedAt: string; taskId?: string; isFinal?: boolean };
const validId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const trustedAsset = (value: unknown): value is string => typeof value === "string" && /^\/api\/media\/assets\/[a-zA-Z0-9_-]+\.(png|jpg|webp|mp4|mp3|wav)$/.test(value);


/**
 * Generation DAG canvas (Fodor-style, independently designed): double-click
 * empty space to create a node, node panel holds prompt/model/price, links
 * feed text context or one validated image reference. Media jobs use /api/media and
 * the output lands in the shared media library (addable to the NLE there).
 */
export function GenCanvasBoard({ projectId }: { projectId?: string }) {
  return <ScopedGenCanvas key={projectId ?? "global"} projectId={projectId} />;
}
function ScopedGenCanvas({ projectId }: { projectId?: string }) {
  const suffix = projectId ? `:${projectId}` : "";
  const CANVAS_KEY = `glint:gen-canvas:v1${suffix}`;
  const receiptKey = (id: string) => `glint:gen-canvas:receipt:${projectId ? `${projectId}:` : ""}${id}`;
  const [initialCanvas] = useState(() => {
    try { const raw = localStorage.getItem(CANVAS_KEY); return {raw,canvas:raw === null ? emptyGenCanvas() : parseGenCanvas(JSON.parse(raw)),readable:true}; }
    catch { return {raw:null,canvas:emptyGenCanvas(),readable:false}; }
  });
  const canvasStorageReadable = initialCanvas.readable;
  const canvasRaw = useRef(initialCanvas.raw);
  const [canvas, setCanvas] = useState<GenCanvas>(initialCanvas.canvas);
  const persistCanvas = (value: GenCanvas) => {
    if (!canvasStorageReadable) throw new Error("画布记录无法读取，原数据已保留。");
    if (localStorage.getItem(CANVAS_KEY) !== canvasRaw.current) throw new Error("其他窗口已更新生成画布；未覆盖对方记录，也未提交新任务。请先备份当前草稿再重开。");
    const raw = JSON.stringify(value);
    localStorage.setItem(CANVAS_KEY, raw);
    if (localStorage.getItem(CANVAS_KEY) !== raw) throw new Error("画布保存未通过核对，未提交新任务。");
    canvasRaw.current = raw;
  };
  const [selected, setSelected] = useState<string | null>(null);
  const [linkFrom, setLinkFrom] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [models, setModels] = useState<Model[]>([]);
  const active = useRef(new Set<string>());
  const mounted = useRef(true);
  const layoutKey = `glint:gen-canvas:layout:v1${suffix}`;
  const [layoutInitial] = useState(() => { try { const raw = localStorage.getItem(layoutKey); return {raw,positions:readGenerationLayout(raw),readable:true}; } catch { return {raw:null,positions:{},readable:false}; } });
  const layoutRaw = useRef(layoutInitial.raw);
  const [layout, setLayout] = useState(layoutInitial.positions);
  const [layoutPast, setLayoutPast] = useState<typeof layout[]>([]);
  const [layoutFuture, setLayoutFuture] = useState<typeof layout[]>([]);
  const saveLayout = (next: typeof layout) => {
    if (!layoutInitial.readable) { setError("画布位置记录损坏，原记录保留；请先备份恢复。"); return false; }
    if (localStorage.getItem(layoutKey) !== layoutRaw.current) { setError("其他窗口已更新生成画布布局；请先备份当前草稿再重开，未覆盖对方记录。"); return false; }
    try {
      const raw = JSON.stringify(next); localStorage.setItem(layoutKey, raw);
      if (localStorage.getItem(layoutKey) !== raw) throw new Error();
      layoutRaw.current = raw; setLayout(next); return true;
    } catch { setError("画布位置保存失败，未覆盖当前布局。请检查本机存储。"); return false; }
  };
  const moveLayout = (next: typeof layout) => {
    if (saveLayout(next)) { setLayoutPast(past => [...past.slice(-49), layout]); setLayoutFuture([]); }
  };
  useEffect(() => {
    if (!canvasStorageReadable) return;
    try { persistCanvas(canvas); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "画布内容尚未保存，请勿关闭页面。"); }
  }, [canvas, canvasStorageReadable]);

  // Grid layout: column = longest upstream depth, row = per-column order.
  const positions = useMemo(() => {
    const depth = new Map<string, number>();
    const byId = new Map(canvas.nodes.map(node => [node.id, node]));
    const resolve = (id: string, seen = new Set<string>()): number => {
      if (depth.has(id)) return depth.get(id)!;
      if (seen.has(id)) return 0; // cycle guard (hand-edited files)
      seen.add(id);
      const ups = canvas.edges.filter(edge => edge.to === id).map(edge => edge.from);
      const value = ups.length ? Math.max(...ups.map(up => byId.has(up) ? resolve(up, seen) : 0)) + 1 : 0;
      depth.set(id, value);
      return value;
    };
    const columns = new Map<number, string[]>();
    for (const node of canvas.nodes) {
      const d = resolve(node.id);
      columns.set(d, [...(columns.get(d) ?? []), node.id]);
    }
    const map: Record<string, Pos> = {};
    for (const [d, ids] of columns) ids.forEach((id, row) => { map[id] = { x: 24 + d * GAP_X, y: 20 + row * GAP_Y }; });
    return { ...map, ...layout };
  }, [canvas, layout]);

  const runnable = useMemo(() => new Set(runnableGenNodes(canvas).map(node => node.id)), [canvas]);
  const selectedNode = canvas.nodes.find(node => node.id === selected) ?? null;

  useEffect(() => {
    if (!selectedNode || selectedNode.kind === "text") { setModels([]); return; }
    const controller = new AbortController();
    setModels([]);
    void fetch(`/api/media/models?type=${selectedNode.kind}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) })
      .then(response => { if (!response.ok) throw new Error(); return response.json(); })
      .then(data => { if (!controller.signal.aborted) setModels(Array.isArray(data.models) ? data.models.filter((m: Model) => m && typeof m.id === "string") : []); })
      .catch(() => { if (!controller.signal.aborted) setError("无法读取模型列表，请检查媒体网关。 "); });
    return () => controller.abort();
  }, [selectedNode?.kind]);

  const createNode = (kind: GenNodeKind, position?: Pos) => {
    try {
      const next = addGenNode(canvas, kind, `${KIND_LABEL[kind]}描述…`);
      if (position && !saveLayout({ ...layout, [next.nodes.at(-1)!.id]: position })) return;
      setCanvas(next); setSelected(next.nodes.at(-1)!.id); setError("");
    } catch { setError("画布最多支持 30 个生成节点，请先整理现有任务。"); }
  };

  const patchNode = (id: string, patch: Partial<GenNode>) => {
    setCanvas(current => parseGenCanvas({ ...current, nodes: current.nodes.map(node => node.id === id ? { ...node, ...patch, updatedAt: new Date().toISOString() } : node) }));
  };

  // A receipt is persisted before any paid request. Missing/invalid receipts or
  // failed lookups are uncertain, never a reason to submit again automatically.
  const readReceipt = (id: string): Receipt | null => {
    const raw = localStorage.getItem(receiptKey(id));
    if (!raw) return null;
    const value = JSON.parse(raw) as Receipt;
    if (!validId(value.requestId) || (value.taskId !== undefined && !validId(value.taskId))) throw new Error("任务回执损坏，请先核对网关和素材库。");
    if (value.nodeCreatedAt !== canvas.nodes.find(node => node.id === id)?.createdAt) {
      if (value.isFinal === true) return null;
      throw new Error("节点存在归属不明的未确认任务，请先核对网关和素材库。");
    }
    return value;
  };
  const hasUncertainReceipt = (id: string) => {
    try { const receipt = readReceipt(id); return Boolean(receipt && !receipt.isFinal); }
    catch { return true; }
  };
  const assertReceiptOwner = (id: string, receipt: Receipt) => {
    const current = readReceipt(id);
    if (!current || current.requestId !== receipt.requestId || current.nodeCreatedAt !== receipt.nodeCreatedAt)
      throw new Error("其他窗口已更新任务回执；旧查询结果未覆盖新任务，请重新查询。");
    return current;
  };
  const writeReceipt = (id: string, value: Receipt) => {
    if (value.taskId || value.isFinal) {
      const current = assertReceiptOwner(id, value);
      if (current.isFinal && !value.isFinal || current.taskId && value.taskId && current.taskId !== value.taskId)
        throw new Error("任务回执已变化；未用旧状态覆盖已确认结果。");
    } else {
      const current = readReceipt(id);
      if (current && !current.isFinal && current.requestId !== value.requestId)
        throw new Error("已有未确认任务，未覆盖任务回执或重复提交。");
    }
    const raw = JSON.stringify(value);
    localStorage.setItem(receiptKey(id), raw);
    if (localStorage.getItem(receiptKey(id)) !== raw) throw new Error("无法保存任务回执，未提交任务。");
  };
  const refreshNode = async (id: string, given?: Receipt) => {
    if (active.current.has(id)) return;
    active.current.add(id); setJobs(current => ({ ...current, [id]: "checking" }));
    try {
      const receipt = given ?? readReceipt(id);
      if (!receipt) throw new Error("旧任务没有可恢复的回执，请先核对网关和素材库。");
      let taskId = receipt.taskId;
      if (!taskId) {
        const result = await fetch(`/api/media/request/${encodeURIComponent(receipt.requestId)}`, { signal: AbortSignal.timeout(10000) });
        if (!result.ok) throw new Error("提交回执尚未确认，请先核对网关和素材库，勿重复提交。");
        const data = await result.json();
        if (!validId(data.taskId)) throw new Error("提交回执无效，请先核对网关。");
        taskId = data.taskId;
        writeReceipt(id, { ...receipt, taskId });
      }
      const response = await fetch(`/api/media/status/${encodeURIComponent(taskId!)}`, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error("任务状态读取失败；任务可能仍在执行，请稍后查询。");
      const status = await response.json();
      if (!mounted.current) return;
      const currentReceipt = assertReceiptOwner(id, receipt);
      if (currentReceipt.isFinal && !status.isFinal) throw new Error("任务已结束，未使用迟到的进行中状态回退结果。");
      if (!status.isFinal) { patchNode(id, { state: "running", error: "" }); return; }
      writeReceipt(id, { ...receipt, taskId, isFinal: true });
      if (status.state !== "success") { patchNode(id, { state: "failed", error: `任务结束：${String(status.state).slice(0, 80)}` }); return; }
      if (!trustedAsset(status.assetUrl)) { patchNode(id, { state: "failed", error: "任务结束，但没有可用的本地素材。" }); return; }
      patchNode(id, { state: "done", outputAsset: status.assetUrl, outputCost: typeof status.cost === "number" && Number.isFinite(status.cost) ? status.cost : undefined, error: "" });
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "任务状态未知，请先核对网关。");
    } finally {
      active.current.delete(id);
      if (mounted.current) setJobs(current => { const next = { ...current }; delete next[id]; return next; });
    }
  };
  useEffect(() => {
    mounted.current = true;
    for (const node of canvas.nodes) {
      if (node.state === "queued" || node.state === "running" || (node.kind !== "text" && hasUncertainReceipt(node.id))) void refreshNode(node.id);
    }
    return () => { mounted.current = false; };
    // Recover only on mount; subsequent checks are explicit to avoid endless polling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const detachNode = async (id: string) => {
    if (active.current.has(id) || !window.confirm("只停止本地追踪，不能取消网关任务或保证退款。确定停止追踪？")) return;
    active.current.add(id); setJobs(current => ({ ...current, [id]: "detaching" }));
    try {
      const receipt = readReceipt(id);
      if (!receipt?.taskId) throw new Error("尚无任务 ID，请先查询并核对网关。");
      const response = await fetch(`/api/media/cancel/${encodeURIComponent(receipt.taskId)}`, { method: "POST", signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error("停止追踪未确认，请查询任务状态。");
      writeReceipt(id, { ...receipt, isFinal: true });
      patchNode(id, { state: "failed", error: "已停止本地追踪；网关任务可能仍在运行或计费。" });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "停止追踪失败。"); }
    finally { active.current.delete(id); if (mounted.current) setJobs(current => { const next = { ...current }; delete next[id]; return next; }); }
  };

  const runNode = async (node: GenNode) => {
    if (!runnable.has(node.id) || active.current.has(node.id)) return;
    const sources = canvas.edges.filter(edge => edge.to === node.id).map(edge => canvas.nodes.find(item => item.id === edge.from));
    const imageSources = sources.filter((source): source is GenNode => Boolean(source && source.kind === "image"));
    if (sources.some(source => !source || (source.kind !== "text" && source.kind !== "image")) || imageSources.length > 1 || (imageSources.length && node.kind !== "image")) { setError("只支持一张图片连向图片节点，其他媒体素材连线暂不可用。"); return; }
    if (!node.prompt.trim()) { setError("请输入文本或提示词。"); return; }
    if (node.kind === "text") { patchNode(node.id, { state: "done", error: "" }); return; }
    if (!canvasStorageReadable) { setError("本地画布数据无法读取，原数据已保留；请先修复存储。 "); return; }
    if (!navigator.locks || !crypto.randomUUID) { setError("当前浏览器不支持安全提交付费任务。"); return; }
    const model = node.model || models[0]?.id;
    if (!model || !models.some(item => item.id === model)) { setError("请选择网关提供的模型。 "); return; }
    if (imageSources.length && !supportsMediaCapability(models.find(item => item.id === model), "skills", "reference-image")) { setError("所选模型未声明图片参考能力，未提交任务。"); return; }
    const prompt = resolveGenPrompt(canvas, node);
    if (!prompt.trim() || prompt.length > 4000) { setError("提示词为空或超过 4000 字。"); return; }
    active.current.add(node.id); setJobs(current => ({ ...current, [node.id]: "submitting" })); setError("");
    let pending: Receipt | undefined;
    try {
      await navigator.locks.request(`glint:gen-canvas${suffix}:${node.id}`, { ifAvailable: true }, async held => {
        if (!held) throw new Error("此节点正由另一标签页操作，请稍后查询。");
        const previous = readReceipt(node.id);
        if (previous && !previous.isFinal) throw new Error("已有未确认任务，请先查询状态，勿重复提交。");
        let canvasReference: { taskId: string; sha256: string } | undefined;
        if (imageSources.length) {
          const source = imageSources[0]!;
          const sourceReceipt = readReceipt(source.id);
          if (!sourceReceipt?.isFinal || !sourceReceipt.taskId || !trustedAsset(source.outputAsset) || !source.outputAsset.startsWith(`/api/media/assets/${sourceReceipt.taskId}.`)) throw new Error("参考图片缺少已完成任务回执，未提交任务。");
          const response = await fetch(source.outputAsset, { signal: AbortSignal.timeout(15000) });
          if (!response.ok) throw new Error("读取参考图片失败，未提交任务。");
          const declared = Number(response.headers.get("content-length"));
          if (declared > 8 * 1024 * 1024) throw new Error("参考图片超过 8 MiB，未提交任务。");
          const bytes = await response.arrayBuffer();
          if (!bytes.byteLength || bytes.byteLength > 8 * 1024 * 1024) throw new Error("参考图片大小无效，未提交任务。");
          const digest = await crypto.subtle.digest("SHA-256", bytes);
          canvasReference = { taskId: sourceReceipt.taskId, sha256: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("") };
        }
        persistCanvas(canvas);
        pending = { requestId: crypto.randomUUID(), nodeCreatedAt: node.createdAt };
        writeReceipt(node.id, pending);
        patchNode(node.id, { state: "queued", model, error: "" });
        const response = await fetch("/api/media/submit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: node.kind, model, prompt, params: {}, requestId: pending.requestId, ...(canvasReference ? { canvasReference } : {}) }), signal: AbortSignal.timeout(150000) });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !validId(data.taskId)) throw new Error("提交回执未确认，请先查询状态或核对网关，勿重复提交。");
        pending = { ...pending, taskId: data.taskId }; writeReceipt(node.id, pending);
        patchNode(node.id, { state: "running" });
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "提交状态未知，请先核对网关。");
    } finally {
      active.current.delete(node.id);
      if (mounted.current) setJobs(current => { const next = { ...current }; delete next[node.id]; return next; });
    }
    if (pending) await refreshNode(node.id, pending);
  };

  const nodeBox: CSSProperties = { width: NODE_W, borderRadius: 12, border: `1px solid ${colors.border}`, background: "var(--ink-2)", padding: "10px 12px", display: "grid", gap: 6, cursor: "pointer" };
  return <section aria-label="生成画布" style={{ ...card, gap: 14 }}>
    <header style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
      <h3 style={heading}>生成画布</h3>
      <p style={{ ...sub, flex: "1 1 320px" }}>文本节点传递提示词；图片节点可作为图片模型参考图发送给网关。生成结果保存到素材库。</p>
    </header>
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {(["text", "image", "video", "audio"] as GenNodeKind[]).map(kind => <button key={kind} type="button" style={button} onClick={() => createNode(kind)}>＋ {KIND_LABEL[kind]}</button>)}
      <button type="button" style={button} title="保存当前节点和布局，不包含素材文件或付费任务回执" onClick={()=>downloadJson(`glint-generation-${projectId ?? "global"}.json`,{version:1,projectId:projectId??null,canvas,layout})}>导出任务草稿</button>
      {linkFrom && <span role="status" style={{ fontSize: 12, color: colors.accentText, alignSelf: "center" }}>正在连线：点目标节点完成，再点「取消连线」放弃</span>}
      {linkFrom && <button type="button" style={button} onClick={() => setLinkFrom(null)}>取消连线</button>}
    </div>
    <div style={{ display: "flex", gap: 8 }}>
      <button type="button" style={button} onClick={() => moveLayout({})}>自动整理</button>
      <button type="button" style={button} disabled={!layoutPast.length} onClick={() => { const previous = layoutPast.at(-1)!; if (saveLayout(previous)) { setLayoutPast(layoutPast.slice(0, -1)); setLayoutFuture([...layoutFuture, layout]); } }}>撤销布局</button>
      <button type="button" style={button} disabled={!layoutFuture.length} onClick={() => { const next = layoutFuture.at(-1)!; if (saveLayout(next)) { setLayoutFuture(layoutFuture.slice(0, -1)); setLayoutPast([...layoutPast, layout]); } }}>重做布局</button>
      <small>滚轮平移 · Ctrl+滚轮缩放 · Shift 多选 · 双击空白添加图片</small>
    </div>
    <GenerationSurface viewportKey={`glint:gen-canvas:viewport:v1${suffix}`} edges={canvas.edges} onMove={moved => moveLayout({ ...layout, ...moved })} onCreate={position => createNode("image", position)} items={canvas.nodes.map(node => {
          const pos = positions[node.id] ?? { x: 24, y: 20 };
          const isSelected = selected === node.id;
          const canRun = runnable.has(node.id) && !jobs[node.id];
          return { id: node.id, position: pos, content: <div key={node.id} style={{ ...nodeBox, borderColor: isSelected ? colors.accent : linkFrom === node.id ? "#5eead4" : colors.border }}
            onClick={() => {
              if (linkFrom && linkFrom !== node.id) {
                const source = canvas.nodes.find(item => item.id === linkFrom);
                if (!source || (source.kind !== "text" && (source.kind !== "image" || node.kind !== "image"))) setError("仅支持文本输入或图片连向图片节点。");
                else if (source.kind === "image" && canvas.edges.some(edge => edge.to === node.id && canvas.nodes.find(item => item.id === edge.from)?.kind === "image")) setError("每个图片节点最多接收一张参考图。");
                else setCanvas(current => linkGenNodes(current, linkFrom, node.id));
                setLinkFrom(null); return;
              }
              setSelected(node.id);
            }}>
            <Handle type="target" position={Position.Left} isConnectable={false} />
            <Handle type="source" position={Position.Right} isConnectable={false} />
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span style={{ width: 8, height: 8, borderRadius: 999, background: KIND_HUE[node.kind] }} />
              <strong style={{ fontSize: 12.5, color: colors.text }}>{KIND_LABEL[node.kind]} · {node.id}</strong>
              <span style={{ marginLeft: "auto", fontSize: 10.5, color: node.state === "done" ? "#5eead4" : node.state === "failed" ? "var(--danger)" : colors.textMuted }}>{{ draft: "草稿", queued: "排队", running: "生成中", done: "完成", failed: "失败" }[node.state]}</span>
            </div>
            <p style={{ margin: 0, fontSize: 11.5, color: colors.textMuted, lineHeight: 1.5, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{node.prompt}</p>
            {node.outputAsset && <a href={applicationUrl(node.outputAsset)} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: colors.accentText }}>查看产物</a>}
            {node.error && <span style={{ fontSize: 11, color: "var(--danger)" }}>{node.error}</span>}
          </div> };
        })} />
    {selectedNode && <div aria-label="节点面板" style={{ display: "grid", gap: 10, padding: 14, borderRadius: 12, border: `1px solid ${colors.accentLine}`, background: colors.accentSoft }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <strong style={{ fontSize: 13 }}>节点 {selectedNode.id}</strong>
        <button type="button" style={button} disabled={!runnable.has(selectedNode.id) || Boolean(jobs[selectedNode.id])} onClick={() => void runNode(selectedNode)}>{selectedNode.kind === "text" ? "确认文本" : "生成（消耗网关额度）"}</button>
        <button type="button" style={button} disabled={selectedNode.kind !== "text" && selectedNode.kind !== "image"} onClick={() => setLinkFrom(selectedNode.id)}>从这里连线</button>
        {selectedNode.kind !== "text" && <button type="button" style={button} disabled={Boolean(jobs[selectedNode.id])} onClick={() => void refreshNode(selectedNode.id)}>查询上次任务</button>}
        {(selectedNode.state === "queued" || selectedNode.state === "running") && <button type="button" style={button} disabled={Boolean(jobs[selectedNode.id])} onClick={() => void detachNode(selectedNode.id)}>停止本地追踪</button>}
        {selectedNode.state === "failed" && <button type="button" style={button} onClick={() => patchNode(selectedNode.id, { state: "draft", error: "" })}>重新编辑</button>}
        <button type="button" style={button} disabled={selectedNode.state === "queued" || selectedNode.state === "running" || Boolean(jobs[selectedNode.id]) || hasUncertainReceipt(selectedNode.id)} onClick={() => { setCanvas(current => removeGenNode(current, selectedNode.id)); setSelected(null); }}>删除节点</button>
        {jobs[selectedNode.id] && <span role="status" style={{ fontSize: 12, color: colors.textMuted }}>任务进行中…</span>}
      </div>
      <label style={fieldLabel}>提示词<textarea aria-label="节点提示词" rows={3} style={{ ...field, fontFamily: "inherit" }} value={selectedNode.prompt} disabled={selectedNode.state === "queued" || selectedNode.state === "running" || selectedNode.state === "done"} onChange={event => patchNode(selectedNode.id, { prompt: event.target.value || " " })} /></label>
      {selectedNode.kind !== "text" && <label style={fieldLabel}>模型<select aria-label="节点模型" style={select} value={selectedNode.model || models[0]?.id || ""} disabled={selectedNode.state !== "draft"} onChange={event => patchNode(selectedNode.id, { model: event.target.value })}><option value="" disabled>没有可用模型</option>{models.map(model => <option key={model.id} value={model.id}>{model.name || model.id}</option>)}</select></label>}
      {selectedNode.state === "done" && <button type="button" style={button} onClick={() => patchNode(selectedNode.id, { state: "draft" })}>编辑并重新执行</button>}
      {selectedNode.state === "done" && canvas.edges.some(edge => edge.from === selectedNode.id) && <small>下游已生成的结果不会自动更新；修改后请重新执行下游节点。</small>}
      {canvas.edges.some(edge => edge.to === selectedNode.id && canvas.nodes.find(item => item.id === edge.from)?.kind === "image") && <small>生成时会将上游图片发送给网关；仅支持 skills 网关中声明图片参考能力的图片模型，图片不超过 8 MiB。</small>}
      {(selectedNode.state === "queued" || selectedNode.state === "running") && <small>任务可能仍在网关执行并产生费用；刷新页面后可查询，不会自动重复提交。</small>}
    </div>}
    {!canvasStorageReadable && <div role="alert" style={alert}>本地画布数据无法读取；原数据已保留，本次修改不会覆盖它。</div>}
    {error && <div role="alert" style={alert}>{error}</div>}
  </section>;
}
