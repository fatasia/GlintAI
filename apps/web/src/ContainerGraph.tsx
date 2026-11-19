import { lazy, Suspense, useMemo, useState } from "react";
import { Handle, Position } from "@xyflow/react";
import type { UnifiedProjectContainer } from "@glintai/scenescript/project-container-v2";
import { savedWorkGraph, type WorkGraphNode } from "./container-graph";
import { Button } from "./ui/Button";
import { t } from "./ui/i18n";
import "./container-graph.css";
const Surface = lazy(() =>
  import("./GenerationSurface").then((module) => ({ default: module.GenerationSurface })),
);
const noop = () => {};

function GraphCard({ node, onSelect }: { node: WorkGraphNode; onSelect(): void }) {
  return (
    <article className="work-graph-card" data-current={node.current}>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <Handle type="source" position={Position.Right} isConnectable={false} />
      <span className="work-graph-kind">{t(`workGraph.${node.kind}`)}</span>
      <Button
        className="work-graph-name nodrag"
        aria-label={t("workGraph.select", { id: node.objectId })}
        onClick={onSelect}
      >
        {node.title}
      </Button>
      <span>{t(node.current ? "workGraph.current" : "workGraph.history")}</span>
      <code>{node.versionId}</code>
    </article>
  );
}

function GraphSelection({ node, onOpen }: { node?: WorkGraphNode; onOpen(id: string): void }) {
  if (!node) return <p className="ws-note">{t("workGraph.hint")}</p>;
  return (
    <aside className="work-graph-selection" aria-label={t("workGraph.selection")}>
      <strong>{node.title}</strong>
      <span>
        {t(`workGraph.${node.kind}`)} ·{" "}
        {t(node.current ? "workGraph.current" : "workGraph.history")}
      </span>
      <code>
        {node.objectId} / {node.versionId}
      </code>
      <code title={node.digest}>{node.digest.slice(0, 16)}</code>
      {node.editable ? (
        <Button onClick={() => onOpen(node.objectId)}>{t("workGraph.open")}</Button>
      ) : (
        <p>{t("workGraph.readonly")}</p>
      )}
    </aside>
  );
}

function GraphPanel({
  container,
  onOpen,
}: {
  container: UnifiedProjectContainer;
  onOpen(id: string): void;
}) {
  const [query, setQuery] = useState(""),
    [selected, setSelected] = useState("");
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  const graph = useMemo(() => savedWorkGraph(container, query), [container, query]);
  const items = useMemo(
    () =>
      graph.nodes.map((node) => ({
        id: node.id,
        position: positions[node.id] ?? node.position,
        content: <GraphCard node={node} onSelect={() => setSelected(node.id)} />,
      })),
    [graph, positions],
  );
  return (
    <div className="work-graph-body">
      <p className="ws-note">{t("workGraph.description")}</p>
      <div className="work-graph-toolbar">
        <label className="ws-label">
          {t("workGraph.search")}
          <input
            className="g-field"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <Button onClick={() => setPositions({})}>{t("workGraph.reset")}</Button>
      </div>
      <p role="status">
        {t("workGraph.count", { total: graph.matched, shown: graph.currentShown })}
      </p>
      {graph.truncated && <p role="status">{t("workGraph.truncated")}</p>}
      {!items.length ? (
        <p role="status">{t("workGraph.empty")}</p>
      ) : (
        <Suspense fallback={<p role="status">{t("container.loading")}</p>}>
          <Surface
            items={items}
            edges={graph.edges}
            onCreate={noop}
            onMove={(next) => setPositions((current) => ({ ...current, ...next }))}
            viewportKey={`glint:work-graph:viewport:${container.id}`}
          />
        </Suspense>
      )}
      <GraphSelection node={graph.nodes.find((node) => node.id === selected)} onOpen={onOpen} />
    </div>
  );
}

export default function ContainerGraph({
  container,
  onOpen,
}: {
  container: UnifiedProjectContainer;
  onOpen(id: string): void;
}) {
  const [opened, setOpened] = useState(false);
  return (
    <details className="work-graph" onToggle={(event) => setOpened(event.currentTarget.open)}>
      <summary>{t("workGraph.title")}</summary>
      {opened && <GraphPanel key={container.id} container={container} onOpen={onOpen} />}
    </details>
  );
}
