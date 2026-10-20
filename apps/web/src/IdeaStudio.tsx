import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { TEMPLATES, THEME_IDS } from "@glintai/composer/templates";
import { jobRequest, parseJob, terminalJob, type IdeaJob } from "./jobs-client";
import { readSavedProjects, removeProject, saveProject, type SavedProject } from "./project-history";
import { type SceneScriptProject } from "@glintai/scenescript";
import { SceneEditor } from "./SceneEditor";
import { parseEditorProject } from "./editor-model";
const labels: Record<string, string> = { recovering: "正在查询任务状态", queued: "排队中", compose: "整理资料", rehearse: "虚拟试讲", render: "渲染视频", stopping: "正在停止", done: "已完成", failed: "失败", cancelled: "已取消", interrupted: "任务已中断" };
const themeLabels = ["暗夜紫", "浅色", "米色编辑部", "薄荷清爽", "大字报"];
const key = "glint.last-job";
const field: CSSProperties = { width: "100%", minWidth: 0, border: "1px solid #35414e", borderRadius: 10, background: "#141b24", color: "#f2f6fa", padding: 12, font: "inherit" };
const button: CSSProperties = { border: "1px solid #586579", borderRadius: 10, background: "#202d3d", color: "#f2f6fa", padding: "12px 18px", font: "inherit", cursor: "pointer" };
export function IdeaStudio({ cardStyle }: { cardStyle: CSSProperties }) {
  const [mode, setMode] = useState<"source" | "idea">("source");
  const [text, setText] = useState("");
  const [template, setTemplate] = useState("explainer");
  const [theme, setTheme] = useState("glint-dark");
  const [aspect, setAspect] = useState("16:9");
  const [job, setJob] = useState<IdeaJob | null>(null);
  const [error, setError] = useState("");
  const [paused, setPaused] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [retry, setRetry] = useState(0);
  const [recoveryRequest, setRecoveryRequest] = useState<string | null>(null);
  const [projects, setProjects] = useState<SavedProject[]>([]);
  const [project, setProject] = useState<SceneScriptProject | null>(null);
  const [review, setReview] = useState<ReturnType<typeof import("@glintai/composer").reviewProject> | null>(null);
  const [evidence, setEvidence] = useState("");
  const currentReviewInput = useRef({ project, evidence }); currentReviewInput.current = { project, evidence };
  const [composing, setComposing] = useState(false);
  const [engine, setEngine] = useState("heuristic");
  const [tts, setTts] = useState("mock");
  const [voiceEngines, setVoiceEngines] = useState<string[]>(["mock"]);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/health", { signal: controller.signal }).then(response => response.json()).then(value => { if (Array.isArray(value.voices)) setVoiceEngines(value.voices); }).catch(() => {});
    return () => controller.abort();
  }, []);
  const [encoding, setEncoding] = useState("draft");
  const [music, setMusic] = useState("off");
  const [musicAssets, setMusicAssets] = useState<{ name: string }[]>([]);
  const refreshMusic = async () => {
    try { const response = await fetch("/api/media/library"); const data = await response.json(); if (response.ok && Array.isArray(data.assets)) setMusicAssets(data.assets.filter((asset: { name: string }) => /\.(mp3|wav)$/.test(asset.name))); } catch { /* Optional media library. */ }
  };
  useEffect(() => { void refreshMusic(); }, []);
  const [storageStatus, setStorageStatus] = useState("");
  const [restored, setRestored] = useState(false);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [editorVersion, setEditorVersion] = useState(0);
  const editorProject = useMemo(() => project ? { ...project, aspect: aspect as SceneScriptProject["aspect"], theme } : null, [project, aspect, theme]);
  const importRef = useRef<HTMLInputElement>(null);
  const lock = useRef(false);
  const mounted = useRef(true);
  const submission = useRef<{ signature: string; requestId: string } | null>(null);
  const active = useRef<AbortController | null>(null);
  const busy = Boolean(recoveryRequest || job && !terminalJob(job));
  useEffect(() => {
    mounted.current = true;
    try {
      setProjects(readSavedProjects());
      const workspace = JSON.parse(localStorage.getItem("glint.workspace") ?? "null");
      if (workspace && typeof workspace.text === "string" && workspace.text.length <= 12000) {
        setText(workspace.text); setMode(workspace.mode === "idea" ? "idea" : "source");
        if (TEMPLATES.some(item => item.id === workspace.template)) setTemplate(workspace.template);
        if (THEME_IDS.includes(workspace.theme)) setTheme(workspace.theme);
        if (["16:9", "9:16", "1:1"].includes(workspace.aspect)) setAspect(workspace.aspect);
        if (workspace.project) setProject(parseEditorProject(workspace.project));
        if (typeof workspace.evidence === "string") setEvidence(workspace.evidence);
        setStorageStatus("已恢复本机草稿");
      }
      const saved = localStorage.getItem(key);
      const pending = localStorage.getItem(`${key}:request`);
      if(pending && /^[a-zA-Z0-9-]{8,80}$/.test(pending)) setRecoveryRequest(pending);
      else if (saved && /^idea-[a-z0-9-]+$/.test(saved)) setJob({ id: saved, status: "recovering", stage: "recovering", log: [] });
    } catch { /* Storage can be disabled. */ }
    setRestored(true);
    return () => { mounted.current = false; active.current?.abort(); };
  }, []);
  useEffect(() => {
    if (!restored) return;
    const timer = setTimeout(() => {
      try { localStorage.setItem("glint.workspace", JSON.stringify({ mode, text, template, theme, aspect, project, evidence })); setStorageStatus("已自动保存到本机"); }
      catch { setStorageStatus("本机存储不可用，请导出 JSON 备份"); }
    }, 600);
    return () => clearTimeout(timer);
  }, [restored, mode, text, template, theme, aspect, project, evidence]);
  const rememberProject = () => {
    if (!text.trim() && !project) return;
    try {
      const next = saveProject({ id: projectId ?? crypto.randomUUID(), name: project?.title ?? text.trim().split(/\r?\n/)[0]?.slice(0, 42) ?? "未命名项目", mode, text, template, theme, aspect, ...(project ? { project, evidence } : {}) });
      setProjectId(next.id); setProjects(readSavedProjects()); setStorageStatus("项目已保存");
    } catch { setError("保存失败，请导出项目 JSON 备份。"); }
  };
  const restoreProject = (saved: SavedProject) => {
    if (busy || submitting || composing) return;
    setMode(saved.mode); setText(saved.text); setTemplate(saved.template); setTheme(saved.theme); setAspect(saved.aspect);
    setProject(saved.project ? parseEditorProject(saved.project) : null); setEditorVersion(value => value + 1); setEvidence(saved.evidence ?? ""); setReview(null); setProjectId(saved.id); setError("");
  };
  const compose = async () => {
    if (lock.current || busy || !text.trim()) return;
    lock.current = true; setComposing(true); setError("");
    const controller = new AbortController(); active.current = controller;
    try {
      const response = await fetch("/api/compose", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ [mode]: text, engine, template, theme, aspect }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]) });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error ?? "编排失败");
      if (mounted.current) { setProject(parseEditorProject(value.project)); setEditorVersion(value => value + 1); setEvidence(value.source); setReview(value.review); if (value.generatedSource) setStorageStatus("模型生成的资料尚未经外部事实核验"); }
    } catch (err) { if (mounted.current) setError(err instanceof Error ? err.message : "编排失败"); }
    finally { lock.current = false; if (mounted.current) setComposing(false); }
  };
  const recheck = async () => {
    if (!project || !evidence) return;
    try { const input = currentReviewInput.current; const result = await jobRequest("/api/review", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: evidence, project }) }); if (mounted.current && currentReviewInput.current.project === input.project && currentReviewInput.current.evidence === input.evidence) setReview(result); }
    catch { setError("核对失败，请检查资料与项目格式。"); }
  };
  useEffect(()=>{
    if(!recoveryRequest || paused)return;
    const controller=new AbortController();
    void jobRequest(`/api/make/request/${recoveryRequest}`,{},controller.signal).then(value=>{
      if(controller.signal.aborted)return;
      const next=parseJob(value);setJob(next);setRecoveryRequest(null);setError("");
      try{localStorage.setItem(key,next.id);localStorage.removeItem(`${key}:request`);}catch{}
    }).catch(()=>{if(!controller.signal.aborted){setPaused(true);setError("提交回执未确认。可恢复查询；不会自动重新提交任务。");}});
    return()=>controller.abort();
  },[recoveryRequest,retry,paused]);
  useEffect(() => {
    if (!job || terminalJob(job) || paused) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let failures = 0;
    const poll = async () => {
      try {
        const next = parseJob(await jobRequest(`/api/make/${job.id}`, {}, controller.signal));
        if (controller.signal.aborted) return;
        failures = 0; setJob(next); setError("");
        if (terminalJob(next)) { submission.current = null; return; }
      } catch (err) {
        if (controller.signal.aborted) return;
        if (++failures >= 3) { setPaused(true); setError("连接中断，任务可能仍在运行。点击恢复查询。"); return; }
      }
      timer = setTimeout(() => void poll(), 1500);
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [job?.id, busy, paused, retry]);
  const submit = async () => {
    if (lock.current || busy || (!text.trim() && !project)) return;
    lock.current = true; setSubmitting(true); setError("");
    const controller = new AbortController(); active.current = controller;
    const payload = { ...(project ? { project: { ...project, aspect, theme } } : { [mode]: text }), template, theme, aspect, tts, encoding, music };
    const signature = JSON.stringify(payload);
    if (submission.current?.signature !== signature) submission.current = { signature, requestId: crypto.randomUUID() };
    try { localStorage.setItem(`${key}:request`,submission.current.requestId); } catch {}
    try {
      const result = await jobRequest("/api/make", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...payload, requestId: submission.current.requestId }) }, controller.signal);
      const next = { ...parseJob({ id: result.jobId, status: "queued", log: [] }), status: "recovering" as const, stage: "recovering" };
      if (!mounted.current) return;
      setJob(next); setPaused(false);
      try { localStorage.setItem(key, next.id); localStorage.removeItem(`${key}:request`); } catch { /* Optional persistence. */ }
    } catch (err) { if (mounted.current) {
      setError(err instanceof Error ? err.message : "提交失败，可恢复查询。");
      if([400,413,503].includes((err as {status?:number})?.status ?? 0)){try{localStorage.removeItem(`${key}:request`);}catch{}}
      else{setRecoveryRequest(submission.current.requestId);setPaused(true);}
    } }
    finally { lock.current = false; if (mounted.current) setSubmitting(false); }
  };
  const cancel = async () => {
    if (!job) return;
    const controller = new AbortController(); active.current = controller;
    setJob({ ...job, status: "cancelling", stage: "stopping" });
    try { await jobRequest(`/api/make/${job.id}`, { method: "DELETE" }, controller.signal); setPaused(false); setRetry((value) => value + 1); }
    catch { if (mounted.current) setError("取消请求未确认，请恢复查询后重试。"); }
  };
  return <section aria-labelledby="make-title" style={{ ...cardStyle, padding: 26, display: "grid", gap: 22 }} onKeyDown={event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); if (!busy && !submitting && !composing) rememberProject(); }
  }}>
    <div><h2 id="make-title" style={{ margin: "0 0 8px", fontSize: 24 }}>把资料变成讲解</h2><p style={{ color: "#a7b4c4", margin: 0 }}>先编排分镜、修改内容，再配音导出。首次使用可载入示例，草稿自动保存在这台设备。</p></div>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
      <button type="button" disabled={busy || composing || submitting} style={button} onClick={() => { setMode("source"); setText("# 清晰的讲解\n\n## 从问题开始\n先说清楚要解决什么问题。\n\n## 给出例子\n展示一个可以重复的操作，再解释结果和限制。"); setProject(null); setReview(null); }}>载入入门示例</button>
      <button type="button" disabled={busy || composing || submitting} style={button} onClick={() => importRef.current?.click()}>导入项目 JSON</button>
      <input ref={importRef} type="file" accept=".json,application/json" hidden onChange={async event => { const file = event.target.files?.[0]; if (!file) return; try { if (file.size > 100000) throw new Error("项目文件超过 100 KB"); const value = parseEditorProject(JSON.parse(await file.text())); setProject(value); setEditorVersion(value => value + 1); setAspect(value.aspect); if (typeof value.theme === "string" && THEME_IDS.some(theme => theme === value.theme)) setTheme(value.theme); setReview(null); setEvidence(""); setProjectId(null); setError(""); } catch (err) { setError(err instanceof Error ? err.message : "导入失败"); } finally { if (importRef.current) importRef.current.value = ""; } }} />
      <span role="status" style={{ fontSize: 13, color: "#a7b4c4" }}>{storageStatus}</span>
    </div>
    {projects.length > 0 && <details>
      <summary style={{ cursor: "pointer", color: "#aecef6" }}>最近项目（本机保存）</summary>
      <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
        {projects.slice(0, 8).map((project) => <div key={project.id} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button type="button" onClick={() => restoreProject(project)} style={{ ...button, flex: 1, textAlign: "left" }}>{project.name}<small style={{ display: "block", color: "#8d9aac" }}>{new Date(project.updatedAt).toLocaleString()}</small></button>
          <button type="button" aria-label={`删除 ${project.name}`} onClick={() => { try { removeProject(project.id); setProjects(readSavedProjects()); } catch { setError("删除失败：本机存储不可用"); } }} style={button}>删除</button>
        </div>)}
      </div>
    </details>}
    <fieldset disabled={busy || submitting || composing} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <legend style={{ padding: "0 0 10px", fontWeight: 600 }}>01 · 输入内容</legend>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <button type="button" aria-pressed={mode === "source"} style={button} onClick={() => { setMode("source"); setText(""); setProject(null); setReview(null); }}>已有资料</button>
        <button type="button" aria-pressed={mode === "idea"} style={button} onClick={() => { setMode("idea"); setText(""); setProject(null); setReview(null); }}>一句话想法</button>
      </div>
      <label htmlFor="make-input">{mode === "source" ? "粘贴 Markdown 或正文（最多 12000 字）" : "描述讲解主题（最多 2000 字）"}</label>
      <textarea id="make-input" maxLength={mode === "source" ? 12000 : 2000} rows={5} value={text} onChange={(event) => { setText(event.target.value); setProject(null); setReview(null); }} placeholder={mode === "source" ? "# 标题\n\n## 核心概念\n资料正文…" : "例如：用扑克牌解释熵"} style={{ ...field, marginTop: 8, resize: "vertical" }} />
    </fieldset>
    <fieldset disabled={busy || submitting || composing} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <legend style={{ padding: "0 0 10px", fontWeight: 600 }}>02 · 选择版式</legend>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 190px), 1fr))", gap: 14 }}>
        <label>叙事模板<select value={template} onChange={(e) => { setTemplate(e.target.value); setProject(null); setReview(null); }} style={field}>{TEMPLATES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <label>视觉主题<select value={theme} onChange={(e) => setTheme(e.target.value)} style={field}>{THEME_IDS.map((id, i) => <option key={id} value={id}>{themeLabels[i]}</option>)}</select></label>
        <label>画面比例<select value={aspect} onChange={(e) => setAspect(e.target.value)} style={field}>{["16:9", "9:16", "1:1"].map((value) => <option key={value}>{value}</option>)}</select></label>
      </div>
      <label>编排方式<select value={engine} onChange={event => setEngine(event.target.value)} style={field}><option value="heuristic">离线编排 · 不联网</option><option value="llm">模型编排 · 需要服务端配置</option></select></label>
      <p style={{ color: "#a7b4c4", fontSize: 13 }}>{TEMPLATES.find((item) => item.id === template)?.description} 资料要求：{TEMPLATES.find((item) => item.id === template)?.requires}。</p>
    </fieldset>
    <fieldset disabled={busy || composing || submitting} style={{ minWidth: 0, border: 0, padding: 0, margin: 0, display: "grid", gap: 14 }}>
      <button type="button" disabled={!text.trim() || composing || busy} onClick={() => void compose()} style={button}>{composing ? "正在编排…" : project ? "重新编排（替换当前分镜）" : "编排分镜"}</button>
      {editorProject && <SceneEditor key={`${editorProject.id}-${editorVersion}`} project={editorProject} voiceEngine={tts} onChange={value => { setProject(value); setReview(null); }} />}
      {project && <button type="button" style={button} disabled={!evidence} onClick={() => void recheck()}>重新核对旁白依据</button>}
      {review && <details><summary>旁白依据 · {review.flagged}/{review.sentences.length} 句需核对</summary><p style={{ color: "#a7b4c4", fontSize: 13 }}>{review.basis}</p>{review.sentences.filter((sentence) => sentence.flags.length).map((sentence, i) => <div key={i} style={{ padding: 10, borderBottom: "1px solid #304053" }}><strong>{sentence.sceneId}</strong><p>{sentence.text}</p><small>{sentence.flags.join(" / ")}</small>{sentence.candidates[0] && <blockquote>资料候选：{sentence.candidates[0].text}</blockquote>}</div>)}</details>}
    </fieldset>
    <div style={{ display: "grid", gap: 12 }}>
      <strong>03 · 制作与下载</strong>
      <p style={{ color: "#a7b4c4", fontSize: 13, margin: 0 }}>分镜优先于输入资料；改写资料或模板后请重新编排。Edge 配音联网，系统音色仅支持 Windows，本地克隆使用服务端参考音频。</p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,210px),1fr))", gap: 12 }}>
        <label>配音<select aria-label="配音" style={field} value={tts} onChange={event => setTts(event.target.value)} disabled={busy || submitting}>{Object.entries({ mock: "无声草稿 · 最快", sapi: "Windows 系统配音 · 离线", edge: "Edge 配音 · 联网", qwen: "Qwen 本地克隆", openai: "OpenAI 兼容配音", elevenlabs: "ElevenLabs · 音色与精准字幕", fish: "Fish Audio · 多语言配音", minimax: "MiniMax · 高品质配音", gateway: "媒体网关 · 云端配音" }).map(([id, label]) => <option key={id} value={id} disabled={!voiceEngines.includes(id)}>{label}{voiceEngines.includes(id) ? "" : " · 未配置"}</option>)}</select></label>
        <label>背景配乐<select aria-label="背景配乐" style={field} value={music} onFocus={() => void refreshMusic()} onChange={event => setMusic(event.target.value)} disabled={busy || submitting}><option value="off">无配乐</option><option value="auto">本地氛围音 · 不联网</option>{musicAssets.map(asset => <option key={asset.name} value={asset.name}>{asset.name}</option>)}</select><small>在素材工坊生成 Suno / MiniMax 音乐后，回到这里选择；复用素材不会重新生成。</small></label>
        <label>导出规格<select aria-label="导出规格" style={field} value={encoding} onChange={event => setEncoding(event.target.value)} disabled={busy || submitting}><option value="draft">预览 · 半尺寸 / 快速</option><option value="compact">紧凑 · 全尺寸 / CRF24</option><option value="balanced">均衡 · 全尺寸 / CRF20</option><option value="quality">母版 · 全尺寸 / CRF16</option></select></label>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
        <button type="button" disabled={busy || submitting || composing || (!text.trim() && !project)} onClick={rememberProject} style={button}>保存项目</button>
        <button disabled={busy || submitting || composing || (!text.trim() && !project)} onClick={() => void submit()} style={{ ...button, background: "#aecef6", color: "#101926", opacity: busy || submitting || composing || (!text.trim() && !project) ? 0.5 : 1 }}>{submitting ? "提交中…" : busy ? "制作中…" : "生成草稿"}</button>
        {busy && job && <button style={button} disabled={job.status === "cancelling"} onClick={() => void cancel()}>取消任务</button>}
        {recoveryRequest && <button style={button} onClick={()=>{setRecoveryRequest(null);setPaused(false);setError("已停止查询；服务器任务未取消。");try{localStorage.removeItem(`${key}:request`);}catch{}}}>停止查询</button>}
        {paused && <button style={button} onClick={() => { setPaused(false); setRetry((value) => value + 1); }}>恢复查询</button>}
        {job && terminalJob(job) && <button style={button} onClick={() => { setJob(null); setError(""); submission.current = null; try { localStorage.removeItem(key); } catch {} }}>清除任务记录</button>}
      </div>
      {error && <p role="alert" style={{ color: "#ffac98", margin: 0, overflowWrap: "anywhere" }}>{error}</p>}
      {job && <div role="status" aria-live="polite" style={{ color: "#a7b4c4" }}>{labels[job.stage ?? job.status] ?? job.status}{job.status === "failed" ? `：${job.error ?? "请检查资料结构和模型配置。"}` : ""}</div>}
      {job && job.log.length > 0 && <details><summary>任务进度</summary><ol>{job.log.map((line, i) => <li key={i}>{labels[line] ?? "处理中"}</li>)}</ol></details>}
      {job?.status === "done" && job.video && <><video aria-label="生成的视频" src={job.video} controls preload="metadata" style={{ width: "100%", maxHeight: 600, borderRadius: 10 }} /><a style={{ color: "#aecef6" }} href={`${job.video}?download=1`} download>下载 MP4</a></>}
    </div>
  </section>;
}
