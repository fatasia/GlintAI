import { appFetch as fetch } from "./app-url";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { parseProject, type SceneScriptProject } from "@glintai/scenescript";
import { canonicalJson } from "@glintai/session";
import { LocalAgentChat } from "./LocalAgentChat";
import { isLocalAgentAvailable } from "./local-agent-client";
import type { ChatContext } from "./local-agent-chat-model";

const button: CSSProperties = { color: "inherit", background: "var(--ink-3)", border: "1px solid var(--line-2)", borderRadius: 8, padding: "8px 12px", font: "inherit", cursor: "pointer" };
type Message = { id: number; role: "user" | "assistant"; target: string; text: string };
type Retry = { projectId: string; targetId: string; input: string };
class StaleProjectError extends Error {}
export function EditorAssistant({ project, sceneId, onChange, canvas, context }: { project: SceneScriptProject; sceneId: string; onChange(project: SceneScriptProject): void; canvas?: { width: number; height: number }; context?: ChatContext }) {
  const [executor, setExecutor] = useState("api");
  const native = isLocalAgentAvailable();
  const [instruction, setInstruction] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [pendingTarget, setPendingTarget] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState<Retry | null>(null);
  /** @ references: typing "@" offers the other scenes as context. */
  const [mention, setMention] = useState(false);
  const [mentionIndex, setMentionIndex] = useState(0);
  const latest = useRef({ project, onChange }); latest.current = { project, onChange };
  const active = useRef<AbortController | null>(null);
  const id = useRef(0);
  const target = project.scenes.find(scene => scene.id === sceneId);
  useEffect(() => () => { active.current?.abort(); active.current = null; }, []);
  const add = (role: Message["role"], target: string, text: string) => setMessages(current => [...current, { id: ++id.current, role, target, text }].slice(-30));
  const insertMention = (index: number) => {
    setInstruction(current => (current.endsWith("@") ? current.slice(0, -1) : current) + `@镜头${index + 1} `);
    setMention(false);
  };
  const send = async (retryRequest?: Retry) => {
    const captured = project;
    const selected = captured.scenes.find(scene => scene.id === (retryRequest?.targetId ?? sceneId));
    const input = (retryRequest?.input ?? instruction).trim();
    if (active.current || !input || !selected || selected.locked || (retryRequest && retryRequest.projectId !== captured.id)) return;
    const targetId = selected.id;
    const revision = canonicalJson(captured);
    const startedAt = Date.now();
    const controller = new AbortController(); active.current = controller;
    const timer = setTimeout(() => {
      if (active.current !== controller) return;
      controller.abort(); active.current = null; setPendingTarget(null);
      const message = "修改超时，原工程未被覆盖，请重试。";
      setError(message); add("assistant", targetId, message);
    }, 65_000);
    setPendingTarget(targetId); setError(""); setRetry(null); if (!retryRequest) setInstruction(""); add("user", targetId, input);
    /** One scene edit against a given project snapshot; returns the patched project. */
    const editScene = async (project: SceneScriptProject, sceneId: string, action: string) => {
      // A plan step may name any sceneId, so each step re-checks the lock: one
      // regressed step would fold into the folded result and undo cannot see it.
      if (project.scenes.find(scene => scene.id === sceneId)?.locked) throw new Error(`镜头 ${sceneId} 已锁定，多步修改已中止，原工程保留。`);
      const response = await fetch("/api/edit-scene", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ project, sceneId, instruction: action }), signal: controller.signal });
      if (!response.ok) throw new Error(response.status === 503 ? "请先配置文本模型；当前工程没有修改。" : "修改未完成，原工程保留。请检查模型服务后重试。");
      const data = await response.json();
      const edited = parseProject(data.project);
      if (edited.id !== project.id || edited.scenes.length !== project.scenes.length || edited.scenes.some((scene, index) => scene.id !== project.scenes[index]!.id)) throw new Error("模型返回的修改范围不正确，未应用。");
      const changed = edited.scenes.find(scene => scene.id === sceneId);
      if (!changed) throw new Error("目标镜头已不存在，未应用。");
      return parseProject({ ...project, scenes: project.scenes.map(scene => scene.id === sceneId ? changed : scene) });
    };
    try {
      // Multi-step: plan first; a 1-scene plan degrades to the
      // original single-call path so simple asks stay one round trip.
      const planResponse = await fetch("/api/assistant/plan", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ project: captured, instruction: input }), signal: controller.signal });
      let plan: Array<{ sceneId: string; action: string }> = [];
      if (planResponse.ok) {
        const data = await planResponse.json();
        plan = Array.isArray(data.steps) ? data.steps : [];
      }
      if (plan.length > 1) {
        // Execute sequentially, folding each step into the next; log per step.
        let working = captured;
        const log: string[] = [];
        for (const [index, step] of plan.entries()) {
          if (active.current !== controller || controller.signal.aborted) return;
          setPendingTarget(step.sceneId);
          working = await editScene(working, step.sceneId, step.action);
          log.push(`${index + 1}. [${step.sceneId}] ${step.action}`);
        }
        if (active.current !== controller || controller.signal.aborted) return;
        if (latest.current.project.id !== captured.id || canonicalJson(latest.current.project) !== revision) throw new StaleProjectError("任务期间工程已变化，本次结果未应用。可基于最新工程重新规划。");
        latest.current.onChange(working);
        const detail = `执行了 ${log.length} 步（耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s）：\n${log.join("\n")}`;
        add("assistant", targetId, detail);
        return;
      }
      const response = await fetch("/api/edit-scene", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ project: captured, sceneId: targetId, instruction: input }), signal: controller.signal });
      if (active.current !== controller || controller.signal.aborted) return;
      if (!response.ok) throw new Error(response.status === 503 ? "请先配置文本模型；当前工程没有修改。" : "修改未完成，原工程保留。请检查模型服务后重试。");
      const data = await response.json();
      if (active.current !== controller || controller.signal.aborted) return;
      if (latest.current.project.id !== captured.id || canonicalJson(latest.current.project) !== revision) throw new StaleProjectError("任务期间工程已变化，本次结果未应用。可基于最新工程重新规划。");
      const edited = parseProject(data.project);
      if (edited.id !== captured.id || edited.scenes.length !== captured.scenes.length || edited.scenes.some((scene, index) => scene.id !== captured.scenes[index]!.id)) throw new Error("模型返回的修改范围不正确，未应用。");
      // Never trust a model to preserve unrelated scenes or project metadata.
      const changed = edited.scenes.find(scene => scene.id === targetId);
      if (!changed) throw new Error("目标镜头已不存在，未应用。");
      const next = parseProject({ ...captured, scenes: captured.scenes.map(scene => scene.id === targetId ? changed : scene) });
      latest.current.onChange(next); add("assistant", targetId, `这一镜已修改（耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s），可预览或撤销。其他镜头未改动。`);
    } catch (error) {
      if (active.current === controller) {
        if (error instanceof StaleProjectError) setRetry({ projectId: captured.id, targetId, input });
        const message = controller.signal.aborted ? String(controller.signal.reason?.message ?? "已取消，原工程未修改。") : error instanceof Error ? error.message : "修改失败，原工程保留。";
        setError(message); add("assistant", targetId, `${message}（耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s）`);
      }
    } finally {
      clearTimeout(timer);
      if (active.current === controller) { active.current = null; setPendingTarget(null); }
    }
  };
  const cancel = () => {
    const current = active.current; if (!current) return;
    current.abort(); active.current = null; setPendingTarget(null); setError("已取消本次修改，原工程保留。");
  };
  return <><label className="local-agent-executor">执行者<select aria-label="创作助手执行者" value={executor} disabled={Boolean(pendingTarget)} title={pendingTarget ? "本轮结束或取消后可切换执行者" : "选择本次对话的执行者"} onChange={event => setExecutor(event.target.value)}><option value="api">API 模型</option><option value="local" disabled={!native}>本地智能体{!native ? "（桌面版可用）" : ""}</option></select></label>
    {executor === "local" && native ? <LocalAgentChat project={project} kind="scene" context={{ sceneId, ...context }} onApply={next => { if ("scenes" in next) onChange(next); }} /> : <section aria-label="创作助手" className="editor-api-chat" style={{ display: "grid", gap: 10, padding: 14, border: "1px solid var(--line-2)", borderRadius: 10, minWidth: 0 }}>
    <strong>告诉我想怎么改</strong>
    <small>当前目标：镜头 {Math.max(0, project.scenes.findIndex(scene => scene.id === sceneId)) + 1} · 发送时固定</small>
    <div className="assistant-history">{messages.length > 0 ? <ol aria-label="本工程修改记录" style={{ margin: 0, paddingLeft: 22, overflowY: "auto" }}>{messages.map(message => <li key={message.id} style={{ marginBottom: 8, overflowWrap: "anywhere" }}><small>{message.role === "user" ? "你" : "助手"} · {message.target}</small><div>{message.text}</div></li>)}</ol> : <div className="assistant-empty"><strong>选中镜头，说说你想怎么改</strong><span>修改文案、布局或节奏。发送后保留本轮目标。</span></div>}</div>
    <label className="assistant-compose">修改要求<textarea aria-label="分镜修改指令" rows={3} maxLength={2000} value={instruction} disabled={Boolean(target?.locked)}
      placeholder="例如：标题更简洁，其他内容保持不变" style={{ ...button, width: "100%", minWidth: 0, boxSizing: "border-box", cursor: "text" }}
      onChange={event => { const value = event.target.value; setInstruction(value); setMention(value.endsWith("@")); setMentionIndex(0); }}
      onKeyDown={event => {
        // While an IME is composing, Enter commits candidates — never pick a mention or send.
        if (mention && !event.nativeEvent.isComposing && project.scenes.length && (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter")) {
          event.preventDefault();
          if (event.key === "Enter") { if (project.scenes[mentionIndex]) insertMention(mentionIndex); return; }
          const next = mentionIndex + (event.key === "ArrowDown" ? 1 : -1);
          setMentionIndex(Math.max(0, Math.min(project.scenes.length - 1, next)));
          return;
        }
        if (event.key === "Escape" && mention) { setMention(false); return; }
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
      }} /></label>
    {mention && project.scenes.length > 0 && <ul role="listbox" aria-label="引用镜头建议" style={{ margin: 0, padding: 4, listStyle: "none", border: "1px solid var(--line-2)", borderRadius: 8, background: "#131318", display: "grid", gap: 2 }}>
      {project.scenes.map((scene, index) => <li key={scene.id}>
        <button type="button" role="option" aria-selected={index === mentionIndex} style={{ ...button, width: "100%", textAlign: "left", padding: "5px 8px", fontSize: 12, background: index === mentionIndex ? "var(--ink-4)" : "transparent" }}
          onClick={() => insertMention(index)}>@镜头{index + 1} · {scene.id} · {scene.kind}</button>
      </li>)}
    </ul>}
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      <button type="button" style={{ ...button, opacity: pendingTarget || !instruction.trim() || target?.locked ? 0.5 : 1 }} disabled={Boolean(pendingTarget) || !instruction.trim() || !target || target.locked} onClick={() => void send()}>AI 修改本分镜</button>
      {canvas && <button type="button" style={button} disabled={Boolean(pendingTarget) || !target || target.locked} title={`按 ${canvas.width}×${canvas.height} 画布重排本镜版式`} onClick={() => { setInstruction(`画布已改为 ${canvas.width}×${canvas.height}，请重排本镜版式：标题与主体按新画幅重新布局，保持旁白不变。`); }}>按画布重排</button>}
      {pendingTarget && <button type="button" style={button} onClick={cancel}>取消修改</button>}</div>
    {target?.locked && <small>当前镜头已锁定，解锁后才能修改。</small>}
    {pendingTarget && <p role="status" style={{ margin: 0 }}>正在修改 {pendingTarget}；浏览其他镜头不会改变本次任务目标。</p>}
    {error && <p role="alert" style={{ margin: 0, overflowWrap: "anywhere" }}>{error}</p>}
    {retry && <div>
      <button type="button" style={button} disabled={Boolean(pendingTarget) || project.id !== retry.projectId || !project.scenes.some(scene => scene.id === retry.targetId && !scene.locked)} onClick={() => void send(retry)}>基于最新工程重新规划</button>
      {(project.id !== retry.projectId || !project.scenes.some(scene => scene.id === retry.targetId && !scene.locked)) && <small> 请返回原工程，并确认原目标镜头存在且未锁定。</small>}
    </div>}
    <details className="assistant-context-note"><summary>上下文与费用</summary><small>输入 @ 可引用其他镜头；整份工程会随指令发给文本模型。Shift+Enter 换行；不自动提交付费图片或视频生成。</small></details>
  </section>}</>;
}
