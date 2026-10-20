import { lazy, Suspense, useState, useEffect, useRef } from "react";
import { buildTimeline, type SceneScriptProject } from "@glintai/scenescript";
import { changeNarration, downloadJson, moveScene } from "./editor-model";
import { PreviewBoundary } from "./PreviewBoundary";

const Preview = lazy(() => import("./ProjectPreview"));
const button = { background: "#1c2938", border: "1px solid #3c4e62", color: "#cee1f8", padding: "8px 12px", borderRadius: 8, cursor: "pointer", font: "inherit" };
const field = { width: "100%", minWidth: 0, padding: 10, borderRadius: 8, border: "1px solid #3c4e62", color: "#f2f6fa", background: "#101924", font: "inherit" };
const names: Record<string, string> = { title: "标题", subtitle: "副标题", heading: "小标题", text: "正文", term: "术语", definition: "释义", attribution: "出处", caption: "说明", label: "标签", note: "补充", code: "代码", language: "语言", items: "要点", points: "条目", left: "左侧", right: "右侧", steps: "步骤", data: "图表数据", value: "数值", unit: "单位" };

function editable(value: unknown, path: (string | number)[] = []): { path: (string | number)[]; text: string | number }[] {
  if (typeof value === "string" || typeof value === "number") return [{ path, text: value }];
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).filter(([key]) => !["id", "kind", "narration", "src", "chartType"].includes(key)).flatMap(([key, child]) => editable(child, [...path, Array.isArray(value) ? Number(key) : key]));
}

export function SceneEditor({ project, onChange, voiceEngine = "mock" }: { project: SceneScriptProject; onChange(project: SceneScriptProject): void; voiceEngine?: string }) {
  const [selected, setSelected] = useState(0);
  const [past, setPast] = useState<SceneScriptProject[]>([]);
  const [future, setFuture] = useState<SceneScriptProject[]>([]);
  const [preview, setPreview] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [voiceError, setVoiceError] = useState("");
  const [voiceAudio, setVoiceAudio] = useState<string | null>(null);
  const [imageAssets, setImageAssets] = useState<{ name: string }[]>([]);
  const refreshImages = async () => { try { const response = await fetch("/api/media/library"); const data = await response.json(); if (response.ok && Array.isArray(data.assets)) setImageAssets(data.assets.filter((item: { name: string }) => /\.(png|jpg|webp)$/.test(item.name))); } catch {} };
  const previewRequest = useRef<AbortController | null>(null);
  const editRequest = useRef<AbortController | null>(null);
  useEffect(() => () => editRequest.current?.abort(), []);
  const [instruction, setInstruction] = useState(""), [editing, setEditing] = useState(false), [editError, setEditError] = useState("");
  const index = Math.min(selected, project.scenes.length - 1);
  const scene = project.scenes[index]!;
  const latestProject = useRef(project); latestProject.current = project;
  useEffect(() => {
    setVoiceAudio(null); setVoiceError("");
    return () => previewRequest.current?.abort();
  }, [scene.id, scene.narration.text, scene.narration.voice, scene.narration.speakingRate, voiceEngine]);
  useEffect(() => () => { if (voiceAudio) URL.revokeObjectURL(voiceAudio); }, [voiceAudio]);
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
      <button type="button" style={button} onClick={() => {
        const id = `chart-${crypto.randomUUID().slice(0, 8)}`;
        commit({ ...project, scenes: [...project.scenes, { id, kind: "chart", chartType: "bar", heading: "示例数据 · 请替换", data: [{ label: "示例 A", value: 10 }, { label: "示例 B", value: 18 }], narration: { text: "这是一组示例数据，请在发布前替换。" } }] }); setSelected(project.scenes.length);
      }}>添加图表（示例数据）</button>
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
      <label>插入素材库图片<select aria-label="插入素材库图片" style={field} value="" onFocus={() => void refreshImages()} disabled={project.scenes.length >= 30} onChange={event => {
        if (!event.target.value) return;
        const next = structuredClone(project); next.scenes.splice(index + 1, 0, { id: `image-${crypto.randomUUID().slice(0, 8)}`, kind: "image", src: `assets/${event.target.value}`, caption: "", narration: { text: "请填写这张图片的讲解。" } }); commit(next); setSelected(index + 1);
      }}><option value="">在素材工坊生成图片后选择</option>{imageAssets.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}</select></label>
      {scene.kind === "chart" && <label>图表类型<select style={field} value={scene.chartType} onChange={event => { const next = structuredClone(project); const target = next.scenes[index]; if (target?.kind === "chart") target.chartType = event.target.value as "bar" | "line"; commit(next); }}><option value="bar">柱状图</option><option value="line">折线图</option></select></label>}
      {editable(scene).map(({ path, text }) => <label key={path.join(".")}>{path.map(part => typeof part === "number" ? part + 1 : names[part] ?? part).join(" / ")}
        {typeof text === "number" ? <input aria-label={path.join(".")} type="number" style={field} value={text} onChange={event => {
          if (!event.target.value || !Number.isFinite(Number(event.target.value))) return;
          const next = structuredClone(project); let cursor: any = next.scenes[index];
          for (const part of path.slice(0, -1)) cursor = cursor[part];
          cursor[path.at(-1)!] = Number(event.target.value); commit(next);
        }} /> : <textarea aria-label={path.join(".")} rows={text.length > 80 ? 4 : 2} style={field} value={text} onChange={event => {
          const next = structuredClone(project);
          let cursor: any = next.scenes[index];
          for (const part of path.slice(0, -1)) cursor = cursor[part];
          cursor[path.at(-1)!] = event.target.value || " "; commit(next);
        }} />}
      </label>)}
      <label>旁白 / 字幕<textarea aria-label="旁白" rows={4} style={field} value={scene.narration.text} onChange={event => commit(changeNarration(project, index, event.target.value))} /></label>
      <label>用一句话修改当前分镜<input aria-label="分镜修改指令" style={field} placeholder="例如：把第二项改成 18，其他内容保持不变" value={instruction} onChange={event => setInstruction(event.target.value)} /></label>
      <button type="button" style={button} disabled={editing || !instruction.trim()} onClick={async () => {
        setEditing(true); setEditError(""); const current = project;
        const controller = new AbortController(); editRequest.current = controller;
        try {
          const response = await fetch("/api/edit-scene", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project, sceneId: scene.id, instruction }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(65000)]) });
          const data = await response.json(); if (!response.ok) throw new Error(data.error);
          controller.signal.throwIfAborted();
          if (current !== latestProject.current) throw new Error("项目已修改，请重新提交指令。");
          commit(data.project); setInstruction("");
        } catch (error) { if (!controller.signal.aborted) setEditError(error instanceof Error ? error.message : "修改失败"); }
        finally { setEditing(false); }
      }}>{editing ? "修改中…" : "AI 修改本分镜"}</button>
      {editError && <p role="alert">{editError}</p>}
      <label>音色 ID（留空使用引擎默认音色）<input aria-label="音色 ID" style={field} value={scene.narration.voice ?? ""} onChange={event => {
        const next = changeNarration(project, index, scene.narration.text);
        next.scenes[index]!.narration.voice = event.target.value || undefined; commit(next);
      }} /></label>
      <label>语速 · {scene.narration.speakingRate ?? 1}×<input aria-label="语速" type="range" min={0.5} max={2} step={0.05} value={scene.narration.speakingRate ?? 1} onChange={event => {
        const next = changeNarration(project, index, scene.narration.text);
        next.scenes[index]!.narration.speakingRate = Number(event.target.value); commit(next);
      }} /></label>
      <button type="button" style={button} disabled={previewing || voiceEngine === "mock"} onClick={async () => {
        setPreviewing(true); setVoiceError(""); setVoiceAudio(null);
        const controller = new AbortController(); previewRequest.current = controller;
        try {
          if (scene.narration.text.length > 300) throw new Error("试听最多 300 字，请先缩短该分镜。");
          const response = await fetch("/api/voice-preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ engine: voiceEngine, text: scene.narration.text, voice: scene.narration.voice, speakingRate: scene.narration.speakingRate }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]) });
          if (!response.ok) throw new Error((await response.json()).error ?? "试听失败");
          const blob = await response.blob(); controller.signal.throwIfAborted();
          setVoiceAudio(URL.createObjectURL(blob));
        } catch (error) { if (!controller.signal.aborted) setVoiceError(error instanceof Error ? error.message : "试听失败"); }
        finally { setPreviewing(false); }
      }}>{previewing ? "生成试听中…" : "试听本分镜"}</button>
      {voiceAudio && <audio aria-label="分镜配音试听" controls src={voiceAudio} />}
      {voiceError && <p role="alert">{voiceError}</p>}
      <small>Qwen 克隆使用参考录音原速，不支持音色 ID 和变速；ElevenLabs / Fish 语速范围 0.7–1.2×。</small>
    </div>
    <small style={{ color: "#91a0b2" }}>无声预览；字幕按文本估时。导出配音后时长以实际音频为准。撤销保留最近 30 次修改。</small>
  </div>;
}
