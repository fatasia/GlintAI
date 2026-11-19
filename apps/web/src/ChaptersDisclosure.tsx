import { lazy, Suspense, useState } from "react";
import type { ChaptersPanelProps } from "./ChaptersPanel";

const Panel = lazy(() => import("./ChaptersPanel").then(module => ({ default: module.ChaptersPanel })));
export function ChaptersDisclosure(props: ChaptersPanelProps) {
  const [mounted, setMounted] = useState(false), [count, setCount] = useState<number | null>(null);
  return <details className="chapters-panel" aria-label="章节管理" onToggle={event => { if (event.currentTarget.open) setMounted(true); }}
    style={{ minWidth: 0, paddingTop: 0 }}>
    <summary className="chapters-summary" style={{ display: "flex", justifyContent: "space-between", padding: "14px 16px" }}>
      <strong>章节 · 独立工程</strong>
      <span className="chapters-count">{count === null ? "展开管理" : `${count} 章`}</span>
    </summary>
    {mounted && <Suspense fallback={<p role="status">正在加载章节…</p>}><Panel {...props} onCountChange={setCount} /></Suspense>}
  </details>;
}
