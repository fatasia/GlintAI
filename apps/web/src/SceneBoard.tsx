import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Background, Controls, Handle, Position, ReactFlow, applyNodeChanges, type NodeProps, type ReactFlowInstance } from "@xyflow/react";
import type { SceneScriptProject } from "@glintai/scenescript";
import { libraryVisuals, materialNodes, readBoardPositions, sceneBoard, type BoardNode, type BoardPositions, type MaterialCardNode, type SceneCardNode } from "./scene-board-model";
import type { LibraryVisual } from "./media-adoption";
import "@xyflow/react/dist/style.css";

const card: CSSProperties = { width: "100%", height: "100%", boxSizing: "border-box", padding: 14, borderRadius: 12,
  border: "1px solid var(--line, currentColor)", background: "var(--surface-1, Canvas)", color: "var(--text, CanvasText)", textAlign: "left", overflow: "hidden" };
const button: CSSProperties = { border: "1px solid #2b2b31", borderRadius: 8, color: "#e4e4e7", background: "#1c1c21", font: "inherit", padding: "7px 11px", cursor: "pointer", fontSize: 13 };
function SceneCard({ data, selected }: NodeProps<SceneCardNode>) {
  return <div style={{ ...card, outline: selected ? "2px solid var(--accent, currentColor)" : undefined }}>
    <Handle type="target" position={Position.Left} style={{ opacity: 0, pointerEvents: "none" }} />
    <small style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}><span>镜头 {data.order}{data.locked ? " · 已锁定" : ""}</span><span>{data.duration}</span></small>
    {data.thumbnail && <img alt="" src={data.thumbnail} style={{ width: "100%", height: 52, objectFit: "cover", borderRadius: 8, marginBottom: 8, display: "block" }} />}
    <strong title={data.title} style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginBottom: 8 }}>{data.title}</strong>
    <span title={data.description} style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", fontSize: 13, lineHeight: 1.6 }}>{data.description}</span>
    <Handle type="source" position={Position.Right} style={{ opacity: 0, pointerEvents: "none" }} />
  </div>;
}
function MaterialCard({ data, selected }: NodeProps<MaterialCardNode>) {
  return <div aria-label="素材节点" style={{ ...card, padding: 12, border: "1px dashed var(--accent, currentColor)", background: "#1a1b24",
    outline: selected ? "2px solid var(--accent, currentColor)" : undefined }}>
    <small style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}><span>素材 · {data.kind === "video" ? "视频" : "图片"}</span><span>素材库</span></small>
    <strong title={data.name} style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{data.name}</strong>
    <small style={{ display: "block", marginTop: 8 }}>点选查看详情</small>
  </div>;
}
const nodeTypes = { sceneCard: SceneCard, materialCard: MaterialCard };
const replaceableKinds = ["image", "video"];

/** Reuses React Flow for viewport/selection/dragging, not a parallel engineering or render model. */
export function SceneBoard({ project, selectedSceneId, onSelect, onAdopt }: { project: SceneScriptProject; selectedSceneId: string; onSelect(id: string): void;
  onAdopt?(name: string, mode: "replace" | "insert"): void;
}) {
  return <ProjectSceneBoard key={project.id} project={project} selectedSceneId={selectedSceneId} onSelect={onSelect} onAdopt={onAdopt} />;
}
function ProjectSceneBoard({ project, selectedSceneId, onSelect, onAdopt }: { project: SceneScriptProject; selectedSceneId: string; onSelect(id: string): void;
  onAdopt?(name: string, mode: "replace" | "insert"): void;
}) {
  const key = `glint.scene-board:${project.id}`;
  const [positions, setPositions] = useState<BoardPositions>(() => {
    try { return readBoardPositions(localStorage.getItem(key)); } catch { return {}; }
  });
  const graph = useMemo(() => sceneBoard(project, selectedSceneId, positions), [project, selectedSceneId, positions]);
  const [nodes, setNodes] = useState<BoardNode[]>(graph.nodes);
  const flow = useRef<ReactFlowInstance<BoardNode> | null>(null);
  const [message, setMessage] = useState("");
  const container = useRef<HTMLElement | null>(null);
  const [compact, setCompact] = useState(false);
  const [materials, setMaterials] = useState<LibraryVisual[]>([]);
  const [selectedMaterial, setSelectedMaterial] = useState<string | null>(null);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryError, setLibraryError] = useState("");
  const [libraryNotice, setLibraryNotice] = useState("");
  const libraryRequest = useRef<AbortController | null>(null);
  const fittedMaterials = useRef(false);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(entries => setCompact((entries[0]?.contentRect.width ?? 900) < 420));
    observer.observe(element); return () => observer.disconnect();
  }, []);
  useEffect(() => () => { libraryRequest.current?.abort(); libraryRequest.current = null; }, []);
  useEffect(() => { setSelectedMaterial(null); }, [selectedSceneId]);
  // Freeze the shelf once so dragging scene cards never makes reference cards jump around.
  const [origin] = useState(() => {
    const cards = graph.nodes;
    if (!cards.length) return { x: 0, y: 0 };
    return { x: Math.max(...cards.map(node => node.position.x + (node.width ?? 240))) + 120, y: Math.min(...cards.map(node => node.position.y)) };
  });
  const materialView = useMemo(() => materialNodes(materials, origin).map(node => ({ ...node, selected: node.data.name === selectedMaterial })), [materials, origin, selectedMaterial]);
  const allNodes = useMemo(() => [...graph.nodes, ...materialView], [graph.nodes, materialView]);
  useEffect(() => { setNodes(allNodes); }, [allNodes]);
  useEffect(() => {
    if (!materials.length || fittedMaterials.current) return;
    fittedMaterials.current = true;
    const frame = requestAnimationFrame(() => { void flow.current?.fitView({ padding: 0.15, duration: 0 }); });
    return () => cancelAnimationFrame(frame);
  }, [materials]);
  const persist = (value: BoardPositions) => {
    setPositions(value);
    try { localStorage.setItem(key, JSON.stringify(value)); setMessage("画布位置已保存；镜头播放顺序不变。"); }
    catch { setMessage("画布位置仅保留到关闭页面；视频工程不受影响。"); }
  };
  const fit = () => { void flow.current?.fitView({ padding: 0.15, duration: 0 }); };
  const showMaterials = async () => {
    libraryRequest.current?.abort();
    const controller = new AbortController(); libraryRequest.current = controller;
    setLibraryLoading(true); setLibraryError(""); setLibraryNotice("");
    const timer = setTimeout(() => { controller.abort(); if (libraryRequest.current === controller) { libraryRequest.current = null; setLibraryLoading(false); setLibraryError("素材读取超时，请重试。"); } }, 15_000);
    try {
      const response = await fetch("/api/media/library", { signal: controller.signal });
      if (!response.ok) throw new Error("素材库暂不可用，请检查本地服务后重试。");
      let data: unknown;
      try { data = await response.json(); } catch { throw new Error("素材列表格式错误，请重试。"); }
      if (libraryRequest.current !== controller || controller.signal.aborted) return;
      const assets = data && typeof data === "object" ? (data as { assets?: unknown }).assets : undefined;
      if (!Array.isArray(assets)) throw new Error("素材列表格式错误，请重试。");
      const visuals = libraryVisuals(assets);
      setMaterials(visuals);
      setSelectedMaterial(current => current && visuals.some(visual => visual.name === current) ? current : null);
      setLibraryNotice(visuals.length ? `已显示 ${visuals.length} 个素材；点选查看详情，采用需再点按钮。` : "素材库暂无图片或视频，可先在素材工坊生成再刷新。");
    } catch (error) {
      if (libraryRequest.current === controller && !controller.signal.aborted) setLibraryError(error instanceof Error ? error.message : "读取素材失败。");
    } finally {
      clearTimeout(timer);
      if (libraryRequest.current === controller) { libraryRequest.current = null; setLibraryLoading(false); }
    }
  };
  const material = materials.find(item => item.name === selectedMaterial);
  const target = project.scenes.find(scene => scene.id === selectedSceneId);
  const canReplace = Boolean(target && replaceableKinds.includes(target.kind));
  return <section ref={container} aria-label="镜头画布" style={{ minWidth: 0, display: "grid", gap: 8,
    "--surface-1": "#151518", "--text": "#e4e4e7", "--line": "#2b2b31", "--accent": "#7c8cff" } as CSSProperties}>
    <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
      <strong style={{ marginRight: "auto" }}>镜头总览</strong>
      {!compact && <><button type="button" style={button} onClick={fit}>看全画布</button>
      <button type="button" style={button} onClick={() => { persist({}); requestAnimationFrame(fit); }}>自动整理</button>
      <button type="button" style={button} aria-label="显示素材" disabled={libraryLoading} onClick={() => void showMaterials()}>{libraryLoading ? "读取素材…" : "显示素材"}</button></>}
    </div>
    <small>{compact ? "点选镜头即可编辑，无需缩放或连接节点。" : "点选镜头即可编辑。拖动只整理工作区，不改变视频顺序；无需连接节点。"}</small>
    {!compact && libraryError && <p role="alert" style={{ margin: 0 }}>{libraryError}</p>}
    {!compact && libraryNotice && !libraryError && <small role="status">{libraryNotice}</small>}
    {compact ? <div role="group" aria-label="镜头列表" style={{ display: "grid", gap: 10 }}>
      {graph.nodes.map(node => <button key={node.id} type="button" aria-pressed={node.selected} onClick={() => onSelect(node.id)}
        style={{ ...card, minHeight: 110, cursor: "pointer", outline: node.selected ? "2px solid var(--accent)" : undefined }}>
        <small style={{ display: "block", marginBottom: 6 }}>镜头 {node.data.order} · {node.data.duration}{node.data.locked ? " · 已锁定" : ""}</small>
        <strong style={{ display: "block", marginBottom: 6 }}>{node.data.title}</strong>
        <span style={{ fontSize: 13, lineHeight: 1.6, overflowWrap: "anywhere" }}>{node.data.description}</span>
      </button>)}
    </div> : <div style={{ height: 330, width: "100%", minWidth: 0, borderRadius: 12, overflow: "hidden", border: "1px solid var(--line)", background: "var(--surface-1)" }}>
      <ReactFlow<BoardNode> nodes={nodes} edges={graph.edges} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.15 }} proOptions={{ hideAttribution: true }}
        onInit={instance => { flow.current = instance; }}
        onNodesChange={changes => setNodes(current => applyNodeChanges(changes, current))}
        onNodeClick={(_, node) => {
          if (node.type === "materialCard") { setSelectedMaterial(node.data.name); return; }
          setSelectedMaterial(null); onSelect(node.id);
        }}
        onNodeDragStop={(_, node) => persist({ ...positions, [node.id]: node.position })}
        onPaneClick={() => setSelectedMaterial(null)}
        nodesConnectable={false} edgesReconnectable={false} deleteKeyCode={null}
        minZoom={0.15} maxZoom={1.5} colorMode="dark" aria-label="镜头总览画布">
        <Background gap={24} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>}
    {!compact && material && <div aria-label="素材详情" style={{ display: "grid", gap: 10, padding: 12, borderRadius: 12,
      border: "1px dashed var(--accent, currentColor)", background: "#151518", color: "var(--text)" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "baseline" }}>
        <strong style={{ marginRight: "auto", overflowWrap: "anywhere" }}>{material.name}</strong>
        <small>{material.kind === "video" ? "视频" : "图片"} · 来自素材库</small>
      </div>
      {material.kind === "video"
        ? <video key={material.name} aria-label="素材视频预览" controls preload="metadata" src={`/api/media/assets/${encodeURIComponent(material.name)}`} style={{ width: "100%", maxHeight: 180, borderRadius: 8, background: "#0c141d" }} />
        : <img alt="素材图片预览" src={`/api/media/assets/${encodeURIComponent(material.name)}`} style={{ width: "100%", maxHeight: 180, objectFit: "contain", borderRadius: 8, background: "#0c141d" }} />}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <button type="button" style={button} disabled={!onAdopt || !target || !canReplace} onClick={() => { if (onAdopt) onAdopt(material.name, "replace"); }}>替换当前镜头素材</button>
        <button type="button" style={button} disabled={!onAdopt || !target} onClick={() => { if (onAdopt) onAdopt(material.name, "insert"); }}>添加为新镜头</button>
      </div>
      {target && !canReplace && <small>当前镜头为文字、图表等结构化内容，仅支持添加为新镜头。</small>}
      {!onAdopt && <small>采用操作尚未接入，这里只做预览。</small>}
    </div>}
    {message && <small role="status">{message}</small>}
  </section>;
}
