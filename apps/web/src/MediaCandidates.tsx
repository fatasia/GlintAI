import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { SceneScriptProject } from "@glintai/scenescript";
import { adoptLibraryVisual, libraryVisual, type LibraryVisual } from "./media-adoption";
const button: CSSProperties = { color: "inherit", background: "#1c1c21", border: "1px solid #2b2b31", padding: "8px 12px", borderRadius: 8, font: "inherit", cursor: "pointer" };
export function MediaCandidates({ project, sceneId, onChange, onSelect }: { project: SceneScriptProject; sceneId: string; onChange(project: SceneScriptProject): void; onSelect?(id: string): void }) {
  const [assets, setAssets] = useState<LibraryVisual[]>([]), [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => { request.current?.abort(); request.current = null; }, []);
  const target = project.scenes.find(scene => scene.id === sceneId);
  const refresh = async () => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setLoading(true); setError("");
    const timer = setTimeout(() => { controller.abort(); if (request.current === controller) { request.current = null; setLoading(false); setError("素材读取超时，请重试。"); } }, 15_000);
    try {
      const response = await fetch("/api/media/library", { signal: controller.signal });
      if (!response.ok) throw new Error("素材库暂不可用，请检查本地服务后重试。");
      const data = await response.json();
      if (request.current !== controller || controller.signal.aborted) return;
      if (!Array.isArray(data.assets)) throw new Error("素材列表格式错误，请重试。");
      const visuals: LibraryVisual[] = [];
      for (const value of data.assets.slice(0, 500)) {
        try { const visual = libraryVisual(value?.name); if (!visuals.some(item => item.name === visual.name)) visuals.push(visual); } catch { /* Non-visual or unsafe entries never become sources. */ }
      }
      setAssets(visuals); if (selected && !visuals.some(asset => asset.name === selected)) setSelected(null);
    } catch (error) { if (request.current === controller && !controller.signal.aborted) setError(error instanceof Error ? error.message : "读取素材失败。"); }
    finally { clearTimeout(timer); if (request.current === controller) { request.current = null; setLoading(false); } }
  };
  const adopt = (mode: "insert" | "replace") => {
    if (!selected || loading) return;
    try {
      const newId = mode === "insert" ? `media-${crypto.randomUUID()}` : undefined;
      const next = adoptLibraryVisual(project, sceneId, selected, mode, newId);
      onChange(next); if (newId) onSelect?.(newId);
      setNotice(mode === "replace" ? "素材已采用，原有旁白、文字和本地效果已保留，可撤销。" : "已添加为新镜头，可继续编辑和撤销。"); setError("");
    } catch (error) { setError(error instanceof Error ? error.message : "素材未采用，原工程保留。"); }
  };
  const asset = assets.find(item => item.name === selected);
  return <details aria-label="素材候选" onToggle={event => { if (event.currentTarget.open && !assets.length && !loading) void refresh(); }}>
    <summary style={{ cursor: "pointer" }}>素材候选 · 先看再采用</summary>
    <div style={{ display: "grid", gap: 10, paddingTop: 10, minWidth: 0 }}>
      <small>来自同一素材工坊，不触发生成或扣费。当前目标：{sceneId}；仅点击采用才修改工程。</small>
      <button type="button" style={button} disabled={loading} onClick={() => void refresh()}>{loading ? "正在读取素材…" : "刷新素材候选"}</button>
      {!assets.length && !loading && <p style={{ margin: 0 }}>还没有图片或视频。可先在素材工坊生成，再回来刷新。</p>}
      <div role="group" aria-label="可采用素材" style={{ display: "flex", gap: 8, overflowX: "auto", padding: 2 }}>
        {assets.map(item => <button type="button" key={item.name} aria-pressed={selected === item.name} style={{ ...button, minWidth: 150, maxWidth: 220, textAlign: "left", overflowWrap: "anywhere" }} onClick={() => { setSelected(item.name); setNotice(""); setError(""); }}>
          {item.kind === "image" && <img alt="" loading="lazy" src={`/api/media/assets/${encodeURIComponent(item.name)}`} style={{ width: "100%", height: 75, objectFit: "contain" }} />}
          <small>{item.kind === "video" ? "视频" : "图片"}</small><div>{item.name}</div>
        </button>)}
      </div>
      {asset && <div style={{ display: "grid", gap: 8 }}>
        {asset.kind === "video" ? <video key={asset.name} aria-label="候选视频预览" controls preload="metadata" src={`/api/media/assets/${encodeURIComponent(asset.name)}`} style={{ width: "100%", maxHeight: 260 }} /> : <img alt="候选图片预览" src={`/api/media/assets/${encodeURIComponent(asset.name)}`} style={{ width: "100%", maxHeight: 260, objectFit: "contain" }} />}
        <small>视频素材默认静音用于画面；采用不会自动修改镜头时长。太短的素材请先调整时长，避免末帧停留。</small>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <button type="button" style={button} disabled={!target || target.locked || loading || !["image", "video"].includes(target.kind)} onClick={() => adopt("replace")}>替换当前镜头素材</button>
          <button type="button" style={button} disabled={!target || target.locked || loading} onClick={() => adopt("insert")}>添加为新镜头</button>
        </div>
        {target && !["image", "video"].includes(target.kind) && <small>当前为文字／图表等结构化镜头，仅支持添加为新镜头，避免覆盖原内容。</small>}
        {target?.locked && <small>当前镜头已锁定，请先解锁。</small>}
      </div>}
      {error && <p role="alert" style={{ margin: 0 }}>{error}</p>}{notice && <p role="status" style={{ margin: 0 }}>{notice}</p>}
    </div>
  </details>;
}
