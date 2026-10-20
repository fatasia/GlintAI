import { lazy, Suspense, useState } from "react";
import { buildTimeline, type SceneScriptProject } from "@glintai/scenescript";
import { changeNarration, downloadJson, moveScene } from "./editor-model";
import { PreviewBoundary } from "./PreviewBoundary";

const Preview = lazy(() => import("./ProjectPreview"));
const button = { background: "#1c2938", border: "1px solid #3c4e62", color: "#cee1f8", padding: "8px 12px", borderRadius: 8, cursor: "pointer", font: "inherit" };
const field = { width: "100%", minWidth: 0, padding: 10, borderRadius: 8, border: "1px solid #3c4e62", color: "#f2f6fa", background: "#101924", font: "inherit" };
const names: Record<string, string> = { title: "标题", subtitle: "副标题", heading: "小标题", text: "正文", term: "术语", definition: "释义", attribution: "出处", caption: "说明", label: "标签", note: "补充", code: "代码", language: "语言", items: "要点", points: "条目", left: "左侧", right: "右侧", steps: "步骤" };

function editable(value: unknown, path: (string | number)[] = []): { path: (string | number)[]; text: string }[] {
  if (typeof value === "string") return [{ path, text: value }];
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).filter(([key]) => !["id", "kind", "narration"].includes(key)).flatMap(([key, child]) => editable(child, [...path, Array.isArray(value) ? Number(key) : key]));
}

export function SceneEditor({ project, onChange }: { project: SceneScriptProject; onChange(project: SceneScriptProject): void }) {
  const [selected, setSelected] = useState(0);
  const [past, setPast] = useState<SceneScriptProject[]>([]);
  const [future, setFuture] = useState<SceneScriptProject[]>([]);
  const [preview, setPreview] = useState(false);
  const index = Math.min(selected, project.scenes.length - 1);
  const scene = project.scenes[index]!;
  const timeline = buildTimeline(project);
  const commit = (next: SceneScriptProject) => { setPast(items => [...items, project].slice(-30)); setFuture([]); onChange(next); };
  const undo = () => { const previous = past.at(-1); if (previous) { setFuture(items => [project, ...items]); setPast(items => items.slice(0, -1)); onChange(previous); } };
  const redo = () => { const next = future[0]; if (next) { setPast(items => [...items, project]); setFuture(items => items.slice(1)); onChange(next); } };
  return <div style={{ display: "grid", gap: 14, minWidth: 0 }} aria-label="分镜编辑器" onKeyDown={event => {
    if (!(event.ctrlKey || event.metaKey) || ["INPUT", "TEXTAREA", "SELECT"].includes((event.target as HTMLElement).tagName)) return;
    if (event.key.toLowerCase() === "z") { event.preventDefault(); if (event.shiftKey) redo(); else undo(); }
    if (event.key.toLowerCase() === "y") { event.preventDefault(); redo(); }
  }}>
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
      <strong>{project.scenes.length} 个分镜 · {(timeline.totalMs / 1000).toFixed(1)} 秒</strong>
      <button type="button" style={button} disabled={!past.length} onClick={undo}>撤销</button>
      <button type="button" style={button} disabled={!future.length} onClick={redo}>重做</button>
      <button type="button" style={button} onClick={() => downloadJson(`${project.id}.scenescript.json`, project)}>导出项目 JSON</button>
      <button type="button" style={button} onClick={() => setPreview(value => !value)}>{preview ? "收起预览" : "播放预览"}</button>
    </div>
    {preview && <PreviewBoundary><Suspense fallback={<p role="status">加载播放器…</p>}><Preview project={project} /></Suspense></PreviewBoundary>}
    <div role="tablist" aria-label="分镜时间线" style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 8, maxWidth: "100%" }}>
      {project.scenes.map((item, position) => <button key={item.id} role="tab" aria-selected={index === position} onClick={() => setSelected(position)} style={{ ...button, minWidth: 115, borderColor: index === position ? "#a8cdf7" : "#3c4e62", textAlign: "left" }}>
        {String(position + 1).padStart(2, "0")} · {item.kind}<small style={{ display: "block", color: "#91a0b2" }}>{(timeline.entries[position]!.durationMs / 1000).toFixed(1)}s</small>
      </button>)}
    </div>
    <div role="tabpanel" style={{ display: "grid", gap: 12, padding: 16, border: "1px solid #304053", borderRadius: 10 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}><strong style={{ marginRight: "auto" }}>{index + 1}. {scene.id}</strong>
        <button type="button" style={button} disabled={index === 0} onClick={() => { commit(moveScene(project, index, -1)); setSelected(index - 1); }}>上移</button>
        <button type="button" style={button} disabled={index === project.scenes.length - 1} onClick={() => { commit(moveScene(project, index, 1)); setSelected(index + 1); }}>下移</button>
        <button type="button" style={button} disabled={project.scenes.length < 2} onClick={() => commit({ ...project, scenes: project.scenes.filter((_, position) => position !== index) })}>删除分镜</button>
      </div>
      {editable(scene).map(({ path, text }) => <label key={path.join(".")}>{path.map(part => typeof part === "number" ? part + 1 : names[part] ?? part).join(" / ")}
        <textarea aria-label={path.join(".")} rows={text.length > 80 ? 4 : 2} style={field} value={text} onChange={event => {
          const next = structuredClone(project);
          let cursor: any = next.scenes[index];
          for (const part of path.slice(0, -1)) cursor = cursor[part];
          cursor[path.at(-1)!] = event.target.value || " "; commit(next);
        }} />
      </label>)}
      <label>旁白 / 字幕<textarea aria-label="旁白" rows={4} style={field} value={scene.narration.text} onChange={event => commit(changeNarration(project, index, event.target.value))} /></label>
    </div>
    <small style={{ color: "#91a0b2" }}>无声预览；字幕按文本估时。导出配音后时长以实际音频为准。撤销保留最近 30 次修改。</small>
  </div>;
}
