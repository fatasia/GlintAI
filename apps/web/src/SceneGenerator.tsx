import { applicationUrl } from "./app-url"; import { supportsMediaCapability } from "@glintai/models";
import { appFetch as fetch } from "./app-url";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { SceneScriptProject } from "@glintai/scenescript";
import { adoptLibraryVisual, libraryVisual } from "./media-adoption";
import { sceneReworkContext, sceneReworkPrompt } from "./scene-rework";

const button: CSSProperties = { color: "inherit", background: "var(--ink-3)", border: "1px solid var(--line-2)", borderRadius: 8, padding: "8px 12px", font: "inherit", cursor: "pointer" };
const field: CSSProperties = { boxSizing: "border-box", width: "100%", minWidth: 0, padding: 10, borderRadius: 8, border: "1px solid var(--line-2)", background: "var(--ink-2)", color: "inherit", font: "inherit" };
type Model = { id: string; name: string; description?: string; tags?: string[] };
type Task = { taskId: string; state?: string; isFinal?: boolean; assetUrl?: string; cost?: number };
const generationKey = (projectId: string, sceneId: string) => `glint.scene-generation:v2:${encodeURIComponent(projectId)}:${encodeURIComponent(sceneId)}`;
type GenerationRecord = { version: 2; projectId: string; sceneId: string; basis: string; requestId: string; taskId?: string; isFinal?: boolean; assetUrl?: string; referenceBound?: boolean };
const LOCAL_ASSET = /^\/api\/media\/assets\/[a-zA-Z0-9_-]{1,100}\.(png|jpg|webp|mp4)$/;
const trustedAsset = (url: string | undefined): url is string => typeof url === "string" && LOCAL_ASSET.test(url);

/**
 * Generate one candidate for the current scene through the configured media
 * gateway. Nothing is adopted automatically; gateway calls can cost money, so a
 * confirmation is required before submitting.
 */
export function SceneGenerator({ project, sceneId, onChange, onSelect, onAdoptReferenceCandidate, pollMs = 2000, initialOpen = false }: {
  project: SceneScriptProject; sceneId: string; onChange(project: SceneScriptProject): void;
  onSelect?(id: string): void; onAdoptReferenceCandidate?(taskId: string, mode: "replace" | "insert"): Promise<boolean>; pollMs?: number; initialOpen?: boolean;
}) {
  const scene = project.scenes.find(item => item.id === sceneId);
  const [open, setOpen] = useState(initialOpen);
  const [type, setType] = useState<"image" | "video">("image");
  const [models, setModels] = useState<Model[]>([]);
  const [model, setModel] = useState("");
  const [protocol, setProtocol] = useState("");
  const [referenceAssetId, setReferenceAssetId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [duration, setDuration] = useState(5);
  const [resolution, setResolution] = useState("480P");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [adopting, setAdopting] = useState(false);
  const adoptLock = useRef(false);
  const [task, setTask] = useState<Task | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [basis, setBasis] = useState<string | null>(null);
  const [origin, setOrigin] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [discardConfirmed, setDiscardConfirmed] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const recoveryController = useRef<AbortController | null>(null);
  const submitLock = useRef(false);
  const request = useRef<{ id: string } | null>(null);
  const journal = useRef<GenerationRecord | null>(null);
  const legacy = useRef(false);
  const latest = useRef({ project, sceneId }); latest.current = { project, sceneId };
  useEffect(() => () => { controller.current?.abort(); controller.current = null; recoveryController.current?.abort(); recoveryController.current = null; }, []);
  useEffect(() => {
    // A generation belongs to one scene; switching scenes must stop its watcher
    // before it can write a candidate into the next scene.
    controller.current?.abort(); controller.current = null;
    recoveryController.current?.abort(); recoveryController.current = null;
    request.current = null; journal.current = null; legacy.current = false; submitLock.current = false;
    setTask(null); setBasis(null); setOrigin(null); setError(""); setNotice(""); setConfirmed(false); setBusy(false); setUncertain(false); setDiscardConfirmed(false);
  }, [project.id, sceneId]);
  const context = scene ? sceneReworkContext(project, scene.id) : null;
  const targetKey = `${project.id}\u0000${sceneId}`;
  const storageKey = generationKey(project.id, sceneId);
  const lockSupported = typeof navigator !== "undefined" && typeof navigator.locks?.request === "function";
  const stale = Boolean(task && (!basis || origin !== targetKey || !context || context.basis !== basis));
  useEffect(() => { setConfirmed(false); }, [project.id, sceneId, type, model, prompt, duration, resolution, context?.basis, referenceAssetId]);
  useEffect(() => { setReferenceAssetId(""); }, [project.id, sceneId, type, model, context?.basis]);
  const supportsReference = protocol === "skills" && type === "image" && supportsMediaCapability(models.find(item => item.id === model), protocol, "reference-image");
  const referenceAssets = context?.assets.filter(asset => (asset.kind === "character" || asset.kind === "product") && asset.approval?.refSha256 && /^assets\/[a-zA-Z0-9_-]{1,100}\.(png|jpg|webp)$/.test(asset.approval.refs[0] ?? "")) ?? [];

  const loadModels = async (kind: "image" | "video" = type) => {
    controller.current?.abort();
    const current = new AbortController(); controller.current = current;
    try {
      const response = await fetch(`/api/media/models?type=${kind}`, { signal: AbortSignal.any([current.signal, AbortSignal.timeout(15_000)]) });
      if (!response.ok) throw new Error();
      const data = await response.json() as { configured?: boolean; protocol?: string; models?: Model[] };
      if (current.signal.aborted) return;
      const list = Array.isArray(data.models) ? data.models.filter(item => item && typeof item.id === "string") : [];
      setModels(list); setModel(list[0]?.id ?? ""); setProtocol(data.protocol ?? "skills");
    } catch { if (!current.signal.aborted) { setModels([]); setModel(""); } }
  };
  const watch = async (taskId: string, signal: AbortSignal) => {
    let next: Task = { taskId, state: "submitted" };
    if (journal.current) {
      journal.current = { ...journal.current, taskId };
      try { localStorage.setItem(generationKey(journal.current.projectId, journal.current.sceneId), JSON.stringify(journal.current)); } catch { /* pre-submission receipt still permits recovery */ }
    }
    setTask(next);
    for (let attempt = 0; attempt < 150 && !signal.aborted; attempt++) {
      await new Promise(done => setTimeout(done, pollMs));
      if (signal.aborted) return;
      try {
        const status = await fetch(`/api/media/status/${encodeURIComponent(taskId)}`, { signal });
        if (!status.ok) throw new Error();
        const value = await status.json() as Task;
        if (signal.aborted) return;
        next = { ...next, ...value };
        setTask(next);
        if (next.isFinal) break;
      } catch { if (!signal.aborted) { setError("生成状态读取失败；任务可能仍在云端执行，请先核对，勿重复提交。"); setBusy(false); setUncertain(true); return; } }
    }
    if (signal.aborted) return;
    if (!next.isFinal) { setUncertain(true); setError("任务仍未结束，请先核对状态，勿重复提交。"); return; }
    setUncertain(false);
    if (trustedAsset(next.assetUrl)) setNotice("候选已生成；确认后再采用，不会自动替换成片。");
    else if (next.assetUrl) setError("生成结果不是本地素材库地址，已拒绝采用；请检查媒体网关。");
    else setError("生成结束但没有可用素材；请检查网关返回或稍后重试。");
  };
  const submit = async () => {
    if (!scene || scene.locked || busy || submitLock.current || uncertain || (task && !task.isFinal) || !confirmed || !prompt.trim() || !model) return;
    if (!lockSupported) { setError("当前浏览器不支持跨标签页互斥，无法安全提交付费任务。"); return; }
    if (referenceAssetId && (!supportsReference || !referenceAssets.some(asset => asset.id === referenceAssetId))) { setError("参考图或模型能力已变化，请重新选择。"); return; }
    let captured: ReturnType<typeof sceneReworkContext>, finalPrompt: string;
    try { captured = sceneReworkContext(project, sceneId); finalPrompt = sceneReworkPrompt(prompt, captured); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "镜头上下文无效。"); return; }
    submitLock.current = true;
    controller.current?.abort();
    recoveryController.current?.abort();
    recoveryController.current = null;
    const current = new AbortController(); controller.current = current;
    setBusy(true); setError(""); setNotice(""); setTask(null);
    let submitted = false;
    try {
      await navigator.locks.request(`glint:scene-generation:${encodeURIComponent(project.id)}:${encodeURIComponent(sceneId)}`, { ifAvailable: true }, async held => {
      if (!held) { setError("该镜头已在另一个标签页提交或查询任务，请先核对回执。"); return; }
      if (current.signal.aborted || latest.current.project.id !== project.id || latest.current.sceneId !== sceneId || sceneReworkContext(latest.current.project, sceneId).basis !== captured.basis) { if (!current.signal.aborted) setError("镜头已变化，未提交；请重新确认。"); return; }
      const params = type === "video"
        ? { aspect: project.aspect, duration, ...(resolution ? { resolution } : {}) }
        : {};
      const requestId = crypto.randomUUID(); request.current = { id: requestId };
      const pending: GenerationRecord = { version: 2, projectId: project.id, sceneId, basis: captured.basis, requestId, referenceBound: Boolean(referenceAssetId) };
      try {
        const previous = localStorage.getItem(storageKey);
        if (previous !== null) {
          let record: GenerationRecord | null = null;
          try { record = JSON.parse(previous); } catch { /* corrupted receipt needs human review */ }
          if (!record || record.version !== 2 || record.projectId !== project.id || record.sceneId !== sceneId || record.isFinal !== true) {
            journal.current = record; setUncertain(true); setError("该镜头已有未确认的请求，请先核对旧任务，未提交新任务。"); return;
          }
        }
        const serialized = JSON.stringify(pending); localStorage.setItem(storageKey, serialized); if (localStorage.getItem(storageKey) !== serialized) throw new Error("storage readback failed");
      }
      catch { setError("无法保存生成回执，未提交任务。请启用本机存储后重试。"); return; }
      journal.current = pending;
      setBasis(captured.basis); setOrigin(targetKey); setConfirmed(false);
      submitted = true;
      const response = await fetch("/api/media/submit", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ type, model, prompt: finalPrompt, params, requestId, ...(referenceAssetId ? { reference: { projectId: project.id, sceneId, assetId: referenceAssetId, basis: captured.basis } } : {}) }),
        signal: AbortSignal.any([current.signal, AbortSignal.timeout(150_000)]) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || typeof data?.taskId !== "string") {
        // The Web service currently collapses provider errors to HTTP 400, even
        // when a submission may have reached the provider. None is a safe retry.
        throw new Error(typeof data?.error === "string" ? data.error : "submit");
      }
      if (current.signal.aborted) return;
      await watch(data.taskId, current.signal);
      });
    } catch {
      if (current.signal.aborted) return;
      if (!submitted) { setError("无法取得跨标签页互斥锁，未提交任务。"); return; }
      // The server may have accepted the task before the response was lost.
      // Recover its receipt instead of blindly submitting a second paid task.
      try {
        const receipt = await fetch(`/api/media/request/${request.current?.id ?? ""}`, { signal: AbortSignal.timeout(10_000) });
        if (receipt.ok) {
          const data = await receipt.json();
          if (current.signal.aborted) return;
          if (typeof data?.taskId === "string") { await watch(data.taskId, current.signal); return; }
        }
      } catch { /* keep the conservative message below */ }
      setUncertain(true); setError("提交回执未确认。请先在素材库或网关确认是否已生成；解除关联后重新提交可能重复计费。");
    } finally { submitLock.current = false; if (!current.signal.aborted) setBusy(false); }
  };
  // Resume an unfinished or finished generation after a reload.
  useEffect(() => {
    let saved: GenerationRecord | null = null, raw: string | null = null;
    try {
      raw = localStorage.getItem(storageKey); saved = JSON.parse(raw ?? "null");
      if (raw !== null && !saved) { setUncertain(true); setError("本机回执损坏，请先核对素材库或网关。"); return; }
      if (!saved) {
        const previousRaw = localStorage.getItem("glint.scene-generation"); legacy.current = previousRaw !== null;
        const previous = JSON.parse(previousRaw ?? "null");
        if (previous?.sceneId === sceneId && previous?.taskId) { legacy.current = true; setUncertain(true); setError("旧任务缺少工程归属，无法自动恢复。请先核对素材库或网关。"); }
        else legacy.current = false;
      }
    } catch { setUncertain(true); setError("本机回执无法读取，请先核对任务与存储状态，勿重复提交。"); return; }
    if (!saved) return;
    if (saved.version !== 2 || saved.projectId !== project.id || saved.sceneId !== sceneId || typeof saved.basis !== "string" || typeof saved.requestId !== "string" || !/^[a-zA-Z0-9-]{8,80}$/.test(saved.requestId)) {
      setUncertain(true); setError("本机回执损坏或归属不符，请先核对素材库或网关。"); return;
    }
    journal.current = saved; request.current = { id: saved.requestId };
    setBasis(saved.basis); setOrigin(`${project.id}\u0000${sceneId}`);
    if (saved.taskId && /^[a-zA-Z0-9_-]{1,100}$/.test(saved.taskId) && saved.isFinal) {
      setTask({ taskId: saved.taskId, isFinal: true, ...(trustedAsset(saved.assetUrl) ? { assetUrl: saved.assetUrl } : {}) });
      return;
    }
    const current = new AbortController(); recoveryController.current = current;
    setBusy(true);
    void (async () => {
      try {
        let id = saved!.taskId;
        if (!id) {
          const response = await fetch(`/api/media/request/${encodeURIComponent(saved!.requestId)}`, { signal: AbortSignal.any([current.signal, AbortSignal.timeout(10000)]) });
          if (!response.ok) throw new Error("receipt unavailable");
          const data = await response.json(); id = typeof data?.taskId === "string" ? data.taskId : undefined;
        }
        if (!id || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error("receipt unavailable");
        if (!current.signal.aborted) await watch(id, current.signal);
      } catch { if (!current.signal.aborted) { setUncertain(true); setError("提交回执未确认，请先核对素材库或网关；不会自动重复提交。"); } }
      finally { if (!current.signal.aborted) setBusy(false); }
    })();
    return () => current.abort();
  }, [project.id, sceneId]);
  useEffect(() => {
    try {
      if (task && basis && origin === targetKey && journal.current?.projectId === project.id && journal.current?.sceneId === sceneId) {
        journal.current = { ...journal.current, taskId: task.taskId, isFinal: task.isFinal, assetUrl: task.assetUrl };
        localStorage.setItem(storageKey, JSON.stringify(journal.current));
      }
    } catch { /* the initial request receipt remains available */ }
  }, [task, basis, origin, targetKey, project.id, sceneId, storageKey]);
  const adopted = (() => {
    if (!trustedAsset(task?.assetUrl)) return null;
    try {
      const name = task.assetUrl.slice("/api/media/assets/".length);
      return { name, kind: libraryVisual(name).kind };
    } catch { return null; }
  })();
  const adopt = async (mode: "replace" | "insert") => {
    if (!scene || !adopted || !basis || origin !== targetKey || sceneReworkContext(project, scene.id).basis !== basis) { setError("镜头或引用资产已变化；候选未采用，请重新生成或手动从素材库选用。"); return; }
    // Old receipts do not state whether a reference was sent. Fail closed when
    // identities are bound, rather than silently bypassing server verification.
    const needsServer = journal.current?.referenceBound === true || (journal.current?.referenceBound === undefined && Boolean(context?.assets.length));
    if (needsServer) {
      if (!task || !onAdoptReferenceCandidate || adoptLock.current) { setError("请同步共享工程后重试；旧候选可手动从素材库选用。"); return; }
      adoptLock.current = true; setAdopting(true); setError("");
      try {
        const ok = await onAdoptReferenceCandidate(task.taskId, mode);
        if (!ok) { setError("参考图或共享工程校验未通过；候选未确认采用，请同步并检查。"); return; }
        setNotice(mode === "replace" ? "已校验参考图并替换当前镜头，可撤销。" : "已校验参考图并添加新镜头，可撤销。");
      } catch { setError("候选采用回执未确认，请先检查共享工程，勿重复提交。"); }
      finally { adoptLock.current = false; setAdopting(false); }
      return;
    }
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
      {!lockSupported && <small role="alert">当前浏览器不支持跨标签页互斥，无法安全提交付费任务。请使用支持 Web Locks 的浏览器。</small>}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <label>类型<select aria-label="生成素材类型" style={{ ...field, width: "auto" }} value={type} disabled={busy} onChange={event => { const nextType = event.target.value as "image" | "video"; setType(nextType); setModels([]); setModel(""); setTask(null); void loadModels(nextType); }}><option value="image">图片</option><option value="video">短视频</option></select></label>
        <label>模型<select aria-label="生成素材模型" style={{ ...field, width: "auto", minWidth: 160 }} value={model} disabled={busy || !models.length} onChange={event => setModel(event.target.value)}>{models.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <button type="button" style={button} disabled={busy} onClick={() => void loadModels()}>刷新模型</button>
      </div>
      {(() => { const selected = models.find(item => item.id === model); if (!selected) return null; return <div aria-label="生成模型说明" style={{ display: "grid", gap: 4 }}>
        {selected.description && <small>{selected.description}</small>}
        {selected.tags && selected.tags.length > 0 && <small>{selected.tags.map(tag => `#${tag}`).join(" ")}</small>}
      </div>; })()}
      {!models.length && <p role="status" style={{ margin: 0 }}>尚未配置媒体网关，或当前类型没有可用模型。<a className="g-link" href="#/settings">在设置中配置媒体服务</a></p>}
      {type === "video" && <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <label>时长（秒）<input aria-label="生成视频时长" type="number" min={4} max={15} step={1} style={{ ...field, width: 96 }} value={duration} disabled={busy} onChange={event => setDuration(Math.max(4, Math.min(15, Number(event.target.value) || 5)))} /></label>
        <label>分辨率（留空由模型决定）<select aria-label="生成视频分辨率" style={{ ...field, width: "auto" }} value={resolution} disabled={busy} onChange={event => setResolution(event.target.value)}><option value="">模型默认</option><option value="480P">480P</option><option value="720P">720P</option><option value="768P">768P</option><option value="1080P">1080P</option><option value="2K">2K</option></select></label>
        <small>画幅跟随工程（{project.aspect}）；不同模型支持的时长/分辨率不同，报错时会给出允许值。</small>
      </div>}
      <label>画面描述<textarea aria-label="生成素材描述" rows={3} style={field} maxLength={4000} value={prompt} disabled={busy} onChange={event => setPrompt(event.target.value)} placeholder="描述主体、场景、镜头与风格；不要放未授权的真人或品牌素材。" /></label>
      {Boolean(context?.assets.length) && <div aria-label="镜头引用资产" style={{ display: "grid", gap: 4 }}><strong>本镜引用资产</strong>{context!.assets.map(asset => <small key={asset.id}>{asset.name} · {asset.version} · {asset.approval ? "已批准" : "未批准"} · {asset.description ?? "未填写外观描述"}</small>)}<small>生成时会将上述文字描述发送给媒体服务；未选择参考图时不会发送图片，不能保证形象一致；旧版批准未绑定图片内容，需新建版本重批。</small></div>}
      {referenceAssets.length > 0 && <label>角色或商品参考图（可选）<select aria-label="生成角色或商品参考图" style={field} disabled={busy || !supportsReference} value={referenceAssetId} onChange={event => setReferenceAssetId(event.target.value)}><option value="">不发送参考图</option>{referenceAssets.map(asset => <option key={asset.id} value={asset.id}>{asset.kind === "product" ? "商品" : "角色"} · {asset.name} · {asset.approval!.refs[0]}</option>)}</select><small>{supportsReference ? "将一张已批准的角色或商品图发送给媒体服务；限 8 MiB，可能产生费用，效果取决于模型。" : "仅 skills 网关中标记图片编辑、图生图或参考能力的图片模型可发送参考图。"}</small></label>}
      <label><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />我确认这次生成可能产生费用，由媒体服务商计价，本机不显示价格表</label>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <button type="button" style={{ ...button, opacity: !lockSupported || !confirmed || busy || uncertain || scene?.locked || (task && !task.isFinal) || !prompt.trim() || !model ? 0.5 : 1 }} disabled={!lockSupported || !scene || scene.locked || !confirmed || busy || uncertain || Boolean(task && !task.isFinal) || !prompt.trim() || !model} onClick={() => void submit()}>{busy ? "生成中…" : "生成候选（可能计费）"}</button>
        {task && !task.isFinal && <small>任务 {task.taskId} · {task.state ?? "执行中"}</small>}
        {task?.isFinal && task.cost !== undefined && <small>费用：{task.cost}</small>}
      </div>
      {uncertain && <div style={{ display: "grid", gap: 6 }}>
        <small>请求 {journal.current?.requestId ?? "未知"}{task ? ` · 任务 ${task.taskId}` : ""}；先到素材库或服务商核对。解除关联不会取消已提交的任务。</small>
        <label><input type="checkbox" checked={discardConfirmed} onChange={event => setDiscardConfirmed(event.target.checked)} />我已核对旧任务，理解新任务可能再次计费</label>
        <button type="button" style={button} disabled={!discardConfirmed || busy} onClick={() => {
          try { localStorage.removeItem(legacy.current ? "glint.scene-generation" : storageKey); if (localStorage.getItem(legacy.current ? "glint.scene-generation" : storageKey) !== null) throw new Error("storage delete failed"); legacy.current = false; journal.current = null; request.current = null; setTask(null); setBasis(null); setOrigin(null); setUncertain(false); setDiscardConfirmed(false); setConfirmed(false); setError(""); setNotice("旧回执已解除关联；如需新任务，请再次确认费用。"); }
          catch { setError("无法更新本机回执，旧任务仍保留。"); }
        }}>解除旧任务关联</button>
      </div>}
      {task?.assetUrl && adopted && <div style={{ display: "grid", gap: 8 }}>
        {stale && <p role="alert">镜头或引用资产已变化，候选不能直接采用。请重新生成，或人工从素材库选用。</p>}
        {adopted.kind === "video"
          ? <video aria-label="候选生成视频" controls preload="metadata" src={applicationUrl(task.assetUrl)} style={{ width: "100%", maxHeight: 320 }} />
          : <img aria-label="候选生成图片" alt="生成的候选素材" src={applicationUrl(task.assetUrl)} style={{ width: "100%", maxHeight: 320, objectFit: "contain" }} />}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <button type="button" style={button} disabled={adopting || stale || !scene || scene.locked || !["image", "video"].includes(scene.kind)} onClick={() => void adopt("replace")}>用候选替换当前镜头</button>
          <button type="button" style={button} disabled={adopting || stale || !scene || scene.locked} onClick={() => void adopt("insert")}>添加为新镜头</button>
        </div>
      </div>}
      {error && <p role="alert" style={{ margin: 0 }}>{error}</p>}
      {notice && <p role="status" style={{ margin: 0 }}>{notice}</p>}
      <small>{open ? "候选会先出现在这里；只有点击采用才会写入工程。" : ""}</small>
    </div>
  </details>;
}
