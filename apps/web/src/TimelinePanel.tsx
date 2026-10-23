import { useEffect, useState, type CSSProperties } from "react";
import { buildTimeline, editTimeline, type SceneScriptProject, type TimelineCommand } from "@glintai/scenescript";

export interface TimelinePanelProps {
  project: SceneScriptProject;
  selectedSceneId: string;
  onChange(project: SceneScriptProject): void;
  onSelect?(id: string): void;
}

const row: CSSProperties = { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 };
const button: CSSProperties = {
  background: "#1c1c21", color: "#e4e4e7", border: "1px solid #2b2b31",
  padding: "7px 11px", borderRadius: 8, cursor: "pointer", font: "inherit", fontSize: 13,
};
const field: CSSProperties = { ...button, width: 112, minWidth: 0, boxSizing: "border-box", cursor: "text" };
const seconds = (ms: number) => `${(ms / 1000).toFixed(2)} 秒`;

function refusal(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/locked/.test(message)) return "操作被拒绝：当前场景或后续场景已锁定。请先解锁，避免改变锁定场景的位置和时长。";
  if (/audio|narration timings/.test(message)) return "操作被拒绝：已有音频或旁白词时间，暂不支持重新计时或分割音轨。请先移除对应音频与时间标记。";
  if (/animation|dynamic|continuity|transition|SFX/.test(message)) return "操作被拒绝：动画、转场或音效的连续性无法保留。请先移除这些内容，再进行场景剪辑。";
  if (/duplicateText/.test(message)) return "请先勾选“复制完整旁白到两段”；不会自动切分旁白文字。";
  if (/100ms/.test(message)) return "操作被拒绝：每段至少保留 100 毫秒。请调整分割位置或裁剪量。";
  if (/safe integer/.test(message)) return "请输入有效的整数毫秒分割位置。";
  if (/last scene/.test(message)) return "不能删除最后一个场景。请先添加其他场景。";
  if (/next scene/.test(message)) return "滚动边界需要下一个场景，请先选择非末尾场景。";
  if (/bounds|handles/.test(message)) return "操作被拒绝：超出已知视频素材范围，请缩小调整量。";
  return "场景剪辑失败，项目未修改。请检查场景数据和素材范围后重试。";
}

/** Scene-level operations only: editTimeline owns all timing and safety semantics. */
export function TimelinePanel({ project, selectedSceneId, onChange, onSelect }: TimelinePanelProps) {
  const timeline = buildTimeline(project);
  const [localSelection, setLocalSelection] = useState(selectedSceneId);
  const [splitMs, setSplitMs] = useState("500");
  const [duplicateText, setDuplicateText] = useState(false);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null);
  useEffect(() => { setLocalSelection(selectedSceneId); }, [selectedSceneId]);
  const activeId = onSelect ? selectedSceneId : localSelection;
  const current = timeline.entries.find(entry => entry.scene.id === activeId) ?? timeline.entries[0];
  const scene = current?.scene;
  const editButton = { ...button, cursor: scene?.locked ? "not-allowed" : "pointer" };
  useEffect(() => { setDuplicateText(false); }, [scene?.id]);

  const select = (id: string) => { setLocalSelection(id); onSelect?.(id); };
  const execute = (command: TimelineCommand, success: string) => {
    let next: SceneScriptProject;
    try { next = editTimeline(project, command); }
    catch (error) { setFeedback({ error: true, text: refusal(error) }); return; }
    onChange(next);
    if (command.type === "ripple-delete") {
      const neighbor = next.scenes[Math.min(current?.index ?? 0, next.scenes.length - 1)];
      if (neighbor) select(neighbor.id);
    }
    if (command.type === "split") setDuplicateText(false);
    setFeedback({ error: false, text: success });
  };

  return <section aria-label="场景剪辑" style={{ display: "grid", gap: 12, minWidth: 0, padding: 12,
    border: "1px solid #26262b", borderRadius: 10, fontVariantNumeric: "tabular-nums", color: "#e4e4e7", background: "#0d0d10" }}>
    <div style={row}><strong style={{ marginRight: "auto" }}>场景剪辑</strong>
      <span aria-label="时间线总时长">{timeline.entries.length} 个场景 · 总时长 {seconds(timeline.totalMs)}</span>
    </div>
    {timeline.entries.length === 0 ? <p>暂无场景。请在分镜编辑器中添加场景后开始剪辑。</p> : <>
      <div role="group" aria-label="场景时长时间线" style={{ overflowX: "auto", paddingBottom: 8 }}>
        <div style={{ display: "flex", gap: 4, minWidth: Math.max(480, timeline.entries.length * 80) }}>
          {timeline.entries.map(entry => <button key={entry.scene.id} type="button"
            aria-pressed={entry.scene.id === scene?.id} aria-label={`选择场景 ${entry.scene.id}`}
            title={`${entry.scene.id} · 起点 ${seconds(entry.startMs)} · 时长 ${seconds(entry.durationMs)}${entry.scene.locked ? " · 已锁定" : ""}`}
            onClick={() => select(entry.scene.id)} style={{ ...button, flex: `${entry.durationMs} 0 0px`, minWidth: 0,
              padding: "8px 4px", overflow: "hidden", textAlign: "left",
              outline: entry.scene.id === scene?.id ? "2px solid #7c8cff" : undefined,
              outlineOffset: -3 }}>
            <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {String(entry.index + 1).padStart(2, "0")} · {entry.scene.id}
            </span>
            <small style={{ display: "block" }}>{seconds(entry.durationMs)}{entry.scene.locked ? " · 已锁定" : ""}</small>
          </button>)}
        </div>
      </div>
      {scene && <>
        <div style={row}><strong style={{ overflowWrap: "anywhere", marginRight: "auto" }}>当前场景：{scene.id}</strong>
          <span>{scene.locked ? "已锁定" : "未锁定"}</span>
          <button type="button" style={button} onClick={() => execute({ type: "lock", sceneId: scene.id, locked: !scene.locked },
            scene.locked ? "当前场景已解锁。" : "当前场景已锁定。")}>{scene.locked ? "解锁当前场景" : "锁定当前场景"}</button>
        </div>
        {scene.locked && <small>先解锁当前场景才能裁剪、分割、滚动边界或删除。</small>}
        <fieldset disabled={scene.locked} title={scene.locked ? "请先解锁当前场景" : undefined}
          style={{ ...row, margin: 0, padding: 0, border: 0, minWidth: 0, opacity: scene.locked ? 0.5 : 1,
            cursor: scene.locked ? "not-allowed" : undefined }}>
          <legend>时长与边界</legend>
          <button type="button" style={editButton} onClick={() => execute({ type: "trim", sceneId: scene.id, edge: "end", deltaMs: 100 }, "末尾已缩短 100 毫秒。")}>末尾 −100 毫秒</button>
          <button type="button" style={editButton} onClick={() => execute({ type: "trim", sceneId: scene.id, edge: "end", deltaMs: -100 }, "末尾已延长 100 毫秒。")}>末尾 +100 毫秒</button>
          <button type="button" style={editButton} onClick={() => execute({ type: "roll", sceneId: scene.id, deltaMs: -100 }, "边界已前移 100 毫秒，总时长不变。")}>滚动边界 −100 毫秒</button>
          <button type="button" style={editButton} onClick={() => execute({ type: "roll", sceneId: scene.id, deltaMs: 100 }, "边界已后移 100 毫秒，总时长不变。")}>滚动边界 +100 毫秒</button>
          <button type="button" style={editButton} onClick={() => execute({ type: "ripple-delete", sceneId: scene.id }, "当前场景已波纹删除，后续场景已前移。")}>波纹删除当前场景</button>
        </fieldset>
        <fieldset disabled={scene.locked} title={scene.locked ? "请先解锁当前场景" : undefined}
          style={{ ...row, margin: 0, padding: 0, border: 0, minWidth: 0, opacity: scene.locked ? 0.5 : 1 }}>
          <legend>分割场景</legend>
          <label>场景内位置（毫秒） <input aria-label="分割位置（场景内毫秒）" type="number" step={1}
            style={field} value={splitMs} onChange={event => setSplitMs(event.target.value)} /></label>
          <label style={row}><input type="checkbox" checked={duplicateText} onChange={event => setDuplicateText(event.target.checked)} />复制完整旁白到两段</label>
          <button type="button" style={editButton} onClick={() => {
            if (!splitMs.trim()) { setFeedback({ error: true, text: "请输入有效的整数毫秒分割位置。" }); return; }
            execute({ type: "split", sceneId: scene.id, atMs: Number(splitMs), newSceneId: `split-${crypto.randomUUID()}`, duplicateText }, "场景已分割，两段均保留完整旁白，请分别检查。 ");
          }}>在此分割</button>
        </fieldset>
      </>}
      <small>仅场景级剪辑，不自动拆分旁白文字；已有音频、词时间、动画或转场的重新计时可能被拒绝。分割位置为本场景内毫秒，不写入项目。</small>
    </>}
    {feedback && <p role={feedback.error ? "alert" : "status"} style={{ margin: 0, overflowWrap: "anywhere" }}>{feedback.text}</p>}
  </section>;
}
