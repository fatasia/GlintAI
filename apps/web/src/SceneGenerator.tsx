import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { SceneScriptProject } from "@glintai/scenescript";
import { adoptLibraryVisual, libraryVisual } from "./media-adoption";

const button: CSSProperties = { color: "inherit", background: "#1c1c21", border: "1px solid #2b2b31", borderRadius: 8, padding: "8px 12px", font: "inherit", cursor: "pointer" };
const field: CSSProperties = { boxSizing: "border-box", width: "100%", minWidth: 0, padding: 10, borderRadius: 8, border: "1px solid #2b2b31", background: "#151518", color: "inherit", font: "inherit" };
type Model = { id: string; name: string; description?: string; tags?: string[] };
type Task = { taskId: string; state?: string; isFinal?: boolean; assetUrl?: string; cost?: number };
const GENERATION_KEY = "glint.scene-generation";
const LOCAL_ASSET = /^\/api\/media\/assets\/[a-zA-Z0-9_-]{1,100}\.(png|jpg|webp|mp4)$/;
const trustedAsset = (url: string | undefined): url is string => typeof url === "string" && LOCAL_ASSET.test(url);

/**
 * Generate one candidate for the current scene through the configured media
 * gateway. Nothing is adopted automatically; gateway calls can cost money, so a
 * confirmation is required before submitting.
 */
export function SceneGenerator({ project, sceneId, onChange, onSelect, pollMs = 2000 }: {
  project: SceneScriptProject; sceneId: string; onChange(project: SceneScriptProject): void;
  onSelect?(id: string): void; pollMs?: number;
}) {
  const scene = project.scenes.find(item => item.id === sceneId);
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<"image" | "video">("image");
  const [models, setModels] = useState<Model[]>([]);
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [duration, setDuration] = useState(5);
  const [resolution, setResolution] = useState("480P");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [task, setTask] = useState<Task | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const controller = useRef<AbortController | null>(null);
  const recoveryController = useRef<AbortController | null>(null);
  const submitLock = useRef(false);
  const request = useRef<{ signature: string; id: string } | null>(null);
  useEffect(() => () => { controller.current?.abort(); controller.current = null; recoveryController.current?.abort(); recoveryController.current = null; }, []);
  useEffect(() => {
    // A generation belongs to one scene; switching scenes must stop its watcher
    // before it can write a candidate into the next scene.
    controller.current?.abort(); controller.current = null;
    recoveryController.current?.abort(); recoveryController.current = null;
    request.current = null; submitLock.current = false;
    setTask(null); setError(""); setNotice(""); setConfirmed(false); setBusy(false);
  }, [sceneId]);

  const loadModels = async (kind: "image" | "video" = type) => {
    controller.current?.abort();
    const current = new AbortController(); controller.current = current;
    setError("");
    try {
      const response = await fetch(`/api/media/models?type=${kind}`, { signal: AbortSignal.any([current.signal, AbortSignal.timeout(15_000)]) });
      if (!response.ok) throw new Error();
      const data = await response.json() as { configured?: boolean; models?: Model[] };
      if (current.signal.aborted) return;
      const list = Array.isArray(data.models) ? data.models.filter(item => item && typeof item.id === "string") : [];
      setModels(list); setModel(list[0]?.id ?? "");
    } catch { if (!current.signal.aborted) { setModels([]); setModel(""); } }
  };
  const watch = async (taskId: string, signal: AbortSignal) => {
    let next: Task = { taskId, state: "submitted" };
    setTask(next);
    for (let attempt = 0; attempt < 150 && !signal.aborted; attempt++) {
      await new Promise(done => setTimeout(done, pollMs));
      if (signal.aborted) return;
      try {
        const status = await fetch(`/api/media/status/${encodeURIComponent(taskId)}`, { signal });
        if (!status.ok) throw new Error();
        const value = await status.json() as Task;
        next = { ...next, ...value };
        setTask(next);
        if (next.isFinal) break;
      } catch { if (!signal.aborted) { setError("生成状态读取失败；任务可能仍在云端执行，请稍后刷新素材库查看，勿重复提交。"); setBusy(false); return; } }
    }
    if (signal.aborted || !next.isFinal) return;
    if (trustedAsset(next.assetUrl)) setNotice("候选已生成；确认后再采用，不会自动替换成片。");
    else if (next.assetUrl) setError("生成结果不是本地素材库地址，已拒绝采用；请检查媒体网关。");
    else setError("生成结束但没有可用素材；请检查网关返回或稍后重试。");
  };
  const submit = async () => {
    if (!scene || busy || submitLock.current || !confirmed || !prompt.trim() || !model) return;
    submitLock.current = true;
    controller.current?.abort();
    recoveryController.current?.abort();
    recoveryController.current = null;
    const current = new AbortController(); controller.current = current;
    setBusy(true); setError(""); setNotice(""); setTask(null);
    try {
      const params = type === "video"
        ? { aspect: project.aspect, duration, ...(resolution ? { resolution } : {}) }
        : {};
      const signature = JSON.stringify([sceneId, type, model, prompt.trim(), params]);
      if (request.current?.signature !== signature) request.current = { signature, id: crypto.randomUUID() };
      const requestId = request.current.id;
      const response = await fetch("/api/media/submit", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ type, model, prompt: prompt.trim(), params, requestId }),
        signal: AbortSignal.any([current.signal, AbortSignal.timeout(150_000)]) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || typeof data?.taskId !== "string") {
        const definite = response.status >= 400 && response.status < 500 && ![408, 409, 425, 429].includes(response.status);
        if (definite) {
          if (!current.signal.aborted) setError(typeof data?.error === "string" ? data.error : "提交被网关拒绝；请检查模型与参数后重试。");
          return;
        }
        throw new Error(typeof data?.error === "string" ? data.error : "submit");
      }
      if (current.signal.aborted) return;
      await watch(data.taskId, current.signal);
    } catch {
      if (current.signal.aborted) return;
      // The server may have accepted the task before the response was lost.
      // Recover its receipt instead of blindly submitting a second paid task.
      try {
        const receipt = await fetch(`/api/media/request/${request.current?.id ?? ""}`, { signal: AbortSignal.timeout(10_000) });
        if (receipt.ok) {
          const data = await receipt.json();
          if (typeof data?.taskId === "string") { await watch(data.taskId, current.signal); return; }
        }
      } catch { /* keep the conservative message below */ }
      setError("提交回执未确认。请先在素材库或网关确认是否已生成，再决定是否重试；直接重复提交可能重复计费。");
    } finally { submitLock.current = false; if (!current.signal.aborted) setBusy(false); }
  };
  // Resume an unfinished or finished generation after a reload.
  useEffect(() => {
    let saved: { taskId?: string; sceneId?: string; isFinal?: boolean; assetUrl?: string } | null = null;
    try { saved = JSON.parse(localStorage.getItem(GENERATION_KEY) ?? "null"); } catch { saved = null; }
    if (!saved || saved.sceneId !== sceneId || typeof saved.taskId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(saved.taskId)) return;
    if (saved.isFinal) {
      setTask({ taskId: saved.taskId, isFinal: true, ...(trustedAsset(saved.assetUrl) ? { assetUrl: saved.assetUrl } : {}) });
      return;
    }
    const current = new AbortController(); recoveryController.current = current;
    void watch(saved.taskId, current.signal);
    return () => current.abort();
  }, [sceneId]);
  useEffect(() => {
    try {
      if (!task) localStorage.removeItem(GENERATION_KEY);
      else localStorage.setItem(GENERATION_KEY, JSON.stringify({ taskId: task.taskId, sceneId, isFinal: task.isFinal, assetUrl: task.assetUrl }));
    } catch { /* storage is optional */ }
  }, [task, sceneId]);
  const adopted = (() => {
    if (!trustedAsset(task?.assetUrl)) return null;
    try {
      const name = task.assetUrl.slice("/api/media/assets/".length);
      return { name, kind: libraryVisual(name).kind };
    } catch { return null; }
  })();
  const adopt = (mode: "replace" | "insert") => {
    if (!scene || !adopted) return;
    try {
      const next = adoptLibraryVisual(project, scene.id, adopted.name, mode);
      onChange(next);
      if (mode === "insert") {
        const known = new Set(project.scenes.map(item => item.id));
        const added = next.scenes.find(item => !known.has(item.id));
        if (added) onSelect?.(added.id);
      }
      setNotice(mode === "replace" ? "已把候选素材替换进当前镜头，可撤销。" : "已把候选素材添加为新镜头，可撤销。");
    } catch (error) { setError(error instanceof Error ? error.message : "候选素材未采用，原工程保留。"); }
  };

  return <details aria-label="为这个镜头生成素材" onToggle={event => {
    if (!event.currentTarget.open) return;
    setOpen(true);
    if (!prompt && scene) setPrompt(scene.kind === "title" ? scene.title : scene.narration.text.slice(0, 500));
    if (!models.length) void loadModels();
  }}>
    <summary aria-live="polite" style={{ cursor: "pointer" }}>生成候选素材（图片 / 短视频）{task && !task.isFinal ? " · 生成中" : task?.isFinal ? " · 候选已就绪" : ""}</summary>
    <div style={{ display: "grid", gap: 10, paddingTop: 10, minWidth: 0 }}>
      <small>通过已配置的媒体网关生成，可能产生费用；这里不会自动提交，也不会自动替换成片。</small>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <label>类型<select aria-label="生成素材类型" style={{ ...field, width: "auto" }} value={type} disabled={busy} onChange={event => { const nextType = event.target.value as "image" | "video"; setType(nextType); setModels([]); setModel(""); setTask(null); void loadModels(nextType); }}><option value="image">图片</option><option value="video">短视频</option></select></label>
        <label>模型<select aria-label="生成素材模型" style={{ ...field, width: "auto", minWidth: 160 }} value={model} disabled={busy || !models.length} onChange={event => setModel(event.target.value)}>{models.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <button type="button" style={button} disabled={busy} onClick={() => void loadModels()}>刷新模型</button>
      </div>
      {(() => { const selected = models.find(item => item.id === model); if (!selected) return null; return <div aria-label="生成模型说明" style={{ display: "grid", gap: 4 }}>
        {selected.description && <small>{selected.description}</small>}
        {selected.tags && selected.tags.length > 0 && <small>{selected.tags.map(tag => `#${tag}`).join(" ")}</small>}
      </div>; })()}
      {!models.length && <p role="status" style={{ margin: 0 }}>尚未配置媒体网关，或当前类型没有可用模型。服务端需要 `GLINT_MEDIA_BASE_URL` 与 `GLINT_MEDIA_API_KEY`。</p>}
      {type === "video" && <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <label>时长（秒）<input aria-label="生成视频时长" type="number" min={4} max={15} step={1} style={{ ...field, width: 96 }} value={duration} disabled={busy} onChange={event => setDuration(Math.max(4, Math.min(15, Number(event.target.value) || 5)))} /></label>
        <label>分辨率（留空由模型决定）<select aria-label="生成视频分辨率" style={{ ...field, width: "auto" }} value={resolution} disabled={busy} onChange={event => setResolution(event.target.value)}><option value="">模型默认</option><option value="480P">480P</option><option value="720P">720P</option><option value="768P">768P</option><option value="1080P">1080P</option><option value="2K">2K</option></select></label>
        <small>画幅跟随工程（{project.aspect}）；不同模型支持的时长/分辨率不同，报错时会给出允许值。</small>
      </div>}
      <label>画面描述<textarea aria-label="生成素材描述" rows={3} style={field} maxLength={4000} value={prompt} disabled={busy} onChange={event => setPrompt(event.target.value)} placeholder="描述主体、场景、镜头与风格；不要放未授权的真人或品牌素材。" /></label>
      <label><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />我确认这次生成可能产生费用，由媒体服务商计价，本机不显示价格表</label>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <button type="button" style={{ ...button, opacity: !confirmed || busy || !prompt.trim() || !model ? 0.5 : 1 }} disabled={!confirmed || busy || !prompt.trim() || !model} onClick={() => void submit()}>{busy ? "生成中…" : "生成候选（可能计费）"}</button>
        {task && !task.isFinal && <small>任务 {task.taskId} · {task.state ?? "执行中"}</small>}
        {task?.isFinal && task.cost !== undefined && <small>费用：{task.cost}</small>}
      </div>
      {task?.assetUrl && adopted && <div style={{ display: "grid", gap: 8 }}>
        {adopted.kind === "video"
          ? <video aria-label="候选生成视频" controls preload="metadata" src={task.assetUrl} style={{ width: "100%", maxHeight: 320 }} />
          : <img aria-label="候选生成图片" alt="生成的候选素材" src={task.assetUrl} style={{ width: "100%", maxHeight: 320, objectFit: "contain" }} />}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <button type="button" style={button} disabled={!scene || scene.locked || !["image", "video"].includes(scene.kind)} onClick={() => adopt("replace")}>用候选替换当前镜头</button>
          <button type="button" style={button} disabled={!scene || scene.locked} onClick={() => adopt("insert")}>添加为新镜头</button>
        </div>
      </div>}
      {error && <p role="alert" style={{ margin: 0 }}>{error}</p>}
      {notice && <p role="status" style={{ margin: 0 }}>{notice}</p>}
      <small>{open ? "候选会先出现在这里；只有点击采用才会写入工程。" : ""}</small>
    </div>
  </details>;
}
