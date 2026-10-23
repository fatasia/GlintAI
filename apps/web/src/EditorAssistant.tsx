import { useEffect, useRef, useState, type CSSProperties } from "react";
import { parseProject, type SceneScriptProject } from "@glintai/scenescript";
import { canonicalJson } from "@glintai/session";

const button: CSSProperties = { color: "inherit", background: "#1c1c21", border: "1px solid #2b2b31", borderRadius: 8, padding: "8px 12px", font: "inherit", cursor: "pointer" };
type Message = { id: number; role: "user" | "assistant"; target: string; text: string };
export function EditorAssistant({ project, sceneId, onChange }: { project: SceneScriptProject; sceneId: string; onChange(project: SceneScriptProject): void }) {
  const [instruction, setInstruction] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [pendingTarget, setPendingTarget] = useState<string | null>(null);
  const [error, setError] = useState("");
  const latest = useRef({ project, onChange }); latest.current = { project, onChange };
  const active = useRef<AbortController | null>(null);
  const id = useRef(0);
  const target = project.scenes.find(scene => scene.id === sceneId);
  useEffect(() => () => { active.current?.abort(); active.current = null; }, []);
  const add = (role: Message["role"], target: string, text: string) => setMessages(current => [...current, { id: ++id.current, role, target, text }].slice(-30));
  const send = async () => {
    if (active.current || !instruction.trim() || !target || target.locked) return;
    const input = instruction.trim(), captured = project, targetId = target.id;
    const revision = canonicalJson(captured);
    const controller = new AbortController(); active.current = controller;
    const timer = setTimeout(() => {
      if (active.current !== controller) return;
      controller.abort(); active.current = null; setPendingTarget(null);
      const message = "修改超时，原工程未被覆盖，请重试。";
      setError(message); add("assistant", targetId, message);
    }, 65_000);
    setPendingTarget(targetId); setError(""); setInstruction(""); add("user", targetId, input);
    try {
      const response = await fetch("/api/edit-scene", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ project: captured, sceneId: targetId, instruction: input }), signal: controller.signal });
      if (active.current !== controller || controller.signal.aborted) return;
      if (!response.ok) throw new Error(response.status === 503 ? "请先配置文本模型；当前工程没有修改。" : "修改未完成，原工程保留。请检查模型服务后重试。");
      const data = await response.json();
      if (active.current !== controller || controller.signal.aborted) return;
      if (latest.current.project.id !== captured.id || canonicalJson(latest.current.project) !== revision) throw new Error("任务期间工程已变化。为保护新修改，本次结果未应用；请重新发送指令。");
      const edited = parseProject(data.project);
      if (edited.id !== captured.id || edited.scenes.length !== captured.scenes.length || edited.scenes.some((scene, index) => scene.id !== captured.scenes[index]!.id)) throw new Error("模型返回的修改范围不正确，未应用。");
      // Never trust a model to preserve unrelated scenes or project metadata.
      const changed = edited.scenes.find(scene => scene.id === targetId);
      if (!changed) throw new Error("目标镜头已不存在，未应用。");
      const next = parseProject({ ...captured, scenes: captured.scenes.map(scene => scene.id === targetId ? changed : scene) });
      latest.current.onChange(next); add("assistant", targetId, "这一镜已修改，可预览或撤销。其他镜头未改动。");
    } catch (error) {
      if (active.current === controller) {
        const message = controller.signal.aborted ? String(controller.signal.reason?.message ?? "已取消，原工程未修改。") : error instanceof Error ? error.message : "修改失败，原工程保留。";
        setError(message); add("assistant", targetId, message);
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
  return <section aria-label="创作助手" style={{ display: "grid", gap: 10, padding: 14, border: "1px solid #2b2b31", borderRadius: 10, minWidth: 0 }}>
    <strong>告诉我想怎么改</strong>
    <small>当前目标：镜头 {Math.max(0, project.scenes.findIndex(scene => scene.id === sceneId)) + 1} · {target?.id ?? "未选择"}。切换作品／创意视图不会重开对话；发送后固定目标。</small>
    {messages.length > 0 && <ol aria-label="本工程修改记录" style={{ margin: 0, paddingLeft: 22, maxHeight: 220, overflowY: "auto" }}>{messages.map(message => <li key={message.id} style={{ marginBottom: 8, overflowWrap: "anywhere" }}><small>{message.role === "user" ? "你" : "助手"} · {message.target}</small><div>{message.text}</div></li>)}</ol>}
    <label>修改要求<input aria-label="分镜修改指令" maxLength={2000} value={instruction} disabled={Boolean(target?.locked)}
      placeholder="例如：标题更简洁，其他内容保持不变" style={{ ...button, width: "100%", minWidth: 0, boxSizing: "border-box", cursor: "text" }}
      onChange={event => setInstruction(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} /></label>
    <div style={{ display: "flex", gap: 8 }}><button type="button" style={{ ...button, opacity: pendingTarget || !instruction.trim() || target?.locked ? 0.5 : 1 }} disabled={Boolean(pendingTarget) || !instruction.trim() || !target || target.locked} onClick={() => void send()}>AI 修改本分镜</button>
      {pendingTarget && <button type="button" style={button} onClick={cancel}>取消修改</button>}</div>
    {target?.locked && <small>当前镜头已锁定，解锁后才能修改。</small>}
    {pendingTarget && <p role="status" style={{ margin: 0 }}>正在修改 {pendingTarget}；浏览其他镜头不会改变本次任务目标。</p>}
    {error && <p role="alert" style={{ margin: 0, overflowWrap: "anywhere" }}>{error}</p>}
    <small>当前助手支持文本模型修改这一镜；不自动提交付费图片／视频生成。</small>
  </section>;
}
