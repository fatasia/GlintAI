import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Background, Controls, MiniMap, ReactFlow, applyNodeChanges, type Node, type NodeProps, type ReactFlowInstance } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./generation-surface.css";
import { parseCanvasViewport } from "./canvas-viewport";

type Point = { x: number; y: number };
type CardNode = Node<{ content: ReactNode }, "generation">;
const nodeTypes = { generation: ({ data }: NodeProps<CardNode>) => <>{data.content}</> };
/** Viewport only: media execution, receipts and DAG validation stay in the owner. */
export function GenerationSurface({ items, edges, onMove, onCreate, minimap = true, viewportKey, onSelection }: {
  onSelection?: (ids: string[]) => void;
  viewportKey?: string;
  minimap?: boolean;
  items: { id: string; position: Point; content: ReactNode }[];
  edges: { from: string; to: string }[];
  onMove(positions: Record<string, Point>): void;
  onCreate(position: Point): void;
}) {
  const flow = useRef<ReactFlowInstance<CardNode> | null>(null);
  const [viewport] = useState(() => {
    try {
      const raw = viewportKey ? localStorage.getItem(viewportKey) : null;
      return { value: viewportKey ? parseCanvasViewport(raw) : undefined, raw, error: "" };
    }
    catch { return { value: undefined, error: "画布视口无法读取，原记录保留；本次不保存视口。" }; }
  });
  const viewportRaw = useRef(viewport.raw ?? null);
  const [viewportError, setViewportError] = useState(viewport.error);
  const [hand, setHand] = useState(false);
  const mapped = useMemo(() => items.map(item => ({ id: item.id, type: "generation" as const, position: item.position, data: { content: item.content }, width: 234 })), [items]);
  const [nodes, setNodes] = useState<CardNode[]>(mapped);
  const selection = JSON.stringify(nodes.filter(node => node.selected).map(node => node.id));
  useEffect(() => { onSelection?.(JSON.parse(selection)); }, [selection, onSelection]);
  useEffect(() => setNodes(current => mapped.map(node => ({ ...node, selected: current.find(previous => previous.id === node.id)?.selected ?? false }))), [mapped]);
  return <div className="generation-surface" aria-label="画布区域" style={{ position: "relative", height: "min(72vh, 800px)", minHeight: 420, width: "100%", background: "var(--ink-1)", border: "1px solid var(--line-2)", borderRadius: 12, overflow: "hidden" }}>
    <ReactFlow<CardNode> nodes={nodes} nodeTypes={nodeTypes}
      edges={edges.map(edge => ({ id: `${edge.from}:${edge.to}`, source: edge.from, target: edge.to, type: "smoothstep" }))}
      onInit={instance => { flow.current = instance; }}
      onNodesChange={changes => setNodes(current => applyNodeChanges(changes, current))}
      onNodeDragStop={(_, node, moved) => onMove(Object.fromEntries((moved.length ? moved : [node]).map(item => [item.id, item.position])))}
      onDoubleClick={event => {
        if (!(event.target as Element).classList.contains("react-flow__pane")) return;
        const point = flow.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY });
        if (point) onCreate(point);
      }}
      onMoveEnd={(_, next) => {
        if (!viewportKey || viewport.error) return;
        try {
          if (localStorage.getItem(viewportKey) !== viewportRaw.current) {
            setViewportError("视口已在其他窗口更新；重新打开后继续，当前记录未覆盖。"); return;
          }
          const raw = JSON.stringify(next); parseCanvasViewport(raw);
          localStorage.setItem(viewportKey, raw);
          if (localStorage.getItem(viewportKey) !== raw) throw new Error();
          viewportRaw.current = raw;
          setViewportError("");
        } catch { setViewportError("视口未保存，请检查本机存储。"); }
      }}
      defaultViewport={viewport.value} zoomOnDoubleClick={false} fitView={!viewport.value} minZoom={0.1} maxZoom={2.5} nodesConnectable={false} edgesReconnectable={false}
      deleteKeyCode={null} selectionOnDrag={!hand} panOnDrag={hand ? [0, 1, 2] : [1, 2]} panOnScroll
      selectionKeyCode="Shift" multiSelectionKeyCode="Shift" colorMode="system" proOptions={{ hideAttribution: true }}>
      <Background gap={24} /><Controls showInteractive={false} />{minimap && <MiniMap pannable zoomable bgColor="var(--ink-2)" maskColor="rgba(128,128,128,.15)" nodeColor="var(--accent)" />}
    </ReactFlow>
    <div role="toolbar" aria-label="画布工具" style={{position:"absolute",right:12,top:12,display:"flex",gap:4,zIndex:5,background:"var(--ink-2)",border:"1px solid var(--line-2)",borderRadius:8,padding:4}}>
      <button type="button" className="g-btn g-btn--sm" aria-pressed={!hand} onClick={()=>setHand(false)}>选择</button>
      <button type="button" className="g-btn g-btn--sm" aria-pressed={hand} onClick={()=>setHand(true)}>抓手</button>
    </div>
    {viewportError && <p role="alert" style={{position:"absolute",bottom:8,left:60,background:"var(--ink-2)",padding:8}}>{viewportError}</p>}
  </div>;
}
