import { useEffect, useRef, useState, type FormEvent } from "react";
import { canonicalJson } from "@glintai/session";
import { useLocalAgentChat } from "./local-agent-chat-controller";
import { CHAT_TEXT_LIMIT, cleanText, configChoices, stateLabel, type AgentEvent, type ChatContext, type ChatKind, type ChatProject, type RequestCard } from "./local-agent-chat-model";
import { captureProject, changeValue, makeChatProposal, projectDigest, validateChatProposal, type ChatProposal, type ChatTurnCapture } from "./local-agent-chat-proposal";
import "./local-agent-chat.css";

export interface LocalAgentChatProps {
  project: ChatProject;
  kind: ChatKind;
  context?: ChatContext;
  onApply(next: ChatProject): void | boolean;
  onSeek?(timeMs: number): void;
  className?: string;
  draftRequest?: { id: string; text: string };
  beforeSend?: () => void;
}
function RequestForm({ card, disabled, answer }: { card: RequestCard; disabled: boolean; answer(payload: { optionId?: string; answers?: Record<string, unknown> }): void }) {
  const [values, setValues] = useState<Record<string, unknown>>({});
  const fields = Object.entries(card.requestedSchema?.properties ?? {});
  const unsupported = fields.some(([, field]) => !["string", "number", "integer", "boolean", "array"].includes(field.type) || field.type === "array" && !field.items?.enum);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const answers: Record<string, unknown> = {};
    for (const [key, field] of fields) {
      const value = values[key] ?? field.default;
      if (value !== undefined && value !== "") answers[key] = value;
      else if (card.requestedSchema?.required?.includes(key) && field.type === "boolean") answers[key] = false;
    }
    answer({ answers });
  };
  return <section className="lac-request" aria-label={card.requestType === "permission" ? "智能体权限请求" : "智能体提问"}>
    <strong>{card.requestType === "permission" ? "这一步需要你确认" : "还需要你补充一点"}</strong>
    <p>{cleanText(card.message ?? card.toolCall?.title) || "智能体想执行一个操作。"}</p>
    {card.requestType === "permission" ? <>
      <small>仅授权这一次，不改变后续权限。</small>
      <div className="lac-row">{(card.options ?? []).filter(option => option.kind === "allow_once" || option.kind === "reject_once").map(option => <button key={option.optionId} type="button" disabled={disabled} title={disabled ? "正在提交回答" : cleanText(option.name)} onClick={() => answer({ optionId: option.optionId })}>{option.kind === "allow_once" ? "允许这一次" : "拒绝"}</button>)}
        <button type="button" disabled={disabled} onClick={() => answer({})}>跳过此操作</button></div>
      {card.toolCall && <details><summary>操作详情</summary><pre>{JSON.stringify(card.toolCall, null, 2)}</pre></details>}
    </> : <form onSubmit={submit}>
      {unsupported ? <p>这个问题的表单格式暂不支持。可跳过，或取消后换一种方式说明。</p> : fields.map(([key, field]) => {
        const required = card.requestedSchema?.required?.includes(key), value = values[key] ?? field.default;
        const label = `${cleanText(field.title) || key}${required ? "（必填）" : ""}`;
        const update = (next: unknown) => setValues(current => ({ ...current, [key]: next }));
        return <label key={key}>{label}
          {field.type === "boolean" ? <input type="checkbox" checked={value === true} onChange={event => update(event.target.checked)} />
            : field.type === "array" ? <select multiple required={required} value={Array.isArray(value) ? value as string[] : []} onChange={event => update([...event.target.selectedOptions].map(option => option.value))}>{field.items?.enum?.map(option => <option key={option} value={option}>{option}</option>)}</select>
            : field.enum ? <select required={required} value={value === undefined ? "" : String(value)} onChange={event => update(field.enum?.find(option => String(option) === event.target.value))}><option value="">请选择</option>{field.enum.map((option, index) => <option key={String(option)} value={String(option)}>{field.enumNames?.[index] ?? String(option)}</option>)}</select>
            : <input required={required} type={field.type === "string" ? "text" : "number"} step={field.type === "integer" ? 1 : "any"} min={field.minimum} max={field.maximum} minLength={field.minLength} maxLength={field.maxLength} value={value === undefined ? "" : String(value)} onChange={event => update(field.type === "string" ? event.target.value : event.target.value === "" ? "" : Number(event.target.value))} />}
          {field.description && <small>{cleanText(field.description)}</small>}
        </label>;
      })}
      <div className="lac-row">{!unsupported && <button type="submit" disabled={disabled}>{disabled ? "正在回答…" : "提交回答"}</button>}<button type="button" disabled={disabled} onClick={() => answer({})}>暂不回答</button></div>
    </form>}
  </section>;
}
function ProposalPreview({ event, capture, project, kind, used, onApply, onSeek, report, readOnly = false }: {
  event: AgentEvent; capture?: ChatTurnCapture; project: ChatProject; kind: ChatKind; used: Set<number>; readOnly?: boolean;
  onApply(next: ChatProject): void | boolean; onSeek?: (timeMs: number) => void; report(message: string): void;
}) {
  const [proposal, setProposal] = useState<ChatProposal | null>(null), [error, setError] = useState("");
  const [open, setOpen] = useState(false), [applied, setApplied] = useState(used.has(event.sequence));
  const latest = useRef({ project, onApply }); latest.current = { project, onApply };
  useEffect(() => {
    let alive = true;
    setProposal(null); setError("");
    void (async () => {
      try {
        if (!capture && (kind === "design" || kind === "script")) throw new Error("无法恢复这轮提案的原始选区上下文，历史提案已禁用。请基于当前文档重新生成。");
        const snapshot = capture?.project ?? captureProject(latest.current.project);
        if (!capture && (!event.baseDigest || await projectDigest(snapshot) !== event.baseDigest)) throw new Error("工程已变化，历史提案不能安全恢复。请基于当前工程重新提出要求。");
        const result = makeChatProposal(event.sequence, kind, snapshot, event.project, capture?.context?.selection);
        if (alive) setProposal(result);
      } catch (cause) { if (alive) setError(cause instanceof Error ? cause.message : "提案无法预览，工程未修改。"); }
    })();
    return () => { alive = false; };
  }, [event, capture, kind]);
  const stale = Boolean(proposal && canonicalJson(captureProject(project)) !== proposal.base);
  const apply = () => {
    if (readOnly || !proposal || used.has(event.sequence)) return;
    try {
      const current = captureProject(latest.current.project);
      if (canonicalJson(current) !== proposal.base) throw new Error("工程已变化，提案未应用。请重新提出要求。");
      if (!capture && (kind === "design" || kind === "script")) throw new Error("原始选区上下文不可用，请重新生成提案。");
      const next = validateChatProposal(kind, current, proposal.next, capture?.context?.selection);
      used.add(event.sequence);
      if (latest.current.onApply(next) === false) { used.delete(event.sequence); throw new Error("编辑器未接受提案，工程未修改。请检查锁定状态。"); }
      setApplied(true); setOpen(false); report("修改已应用，可用编辑器撤销。");
    } catch (cause) { used.delete(event.sequence); setError(cause instanceof Error ? cause.message : "应用失败，请检查工程。"); }
  };
  return <section className="lac-proposal" aria-label="智能体修改提案">
    <div className="lac-row"><strong>{applied ? "修改已应用" : "有一份修改建议"}</strong>{proposal && <span>{proposal.changes.length} 项变化</span>}</div>
    {error && <p role="alert">{error}</p>}
    {!proposal && !error && <p role="status">正在检查提案…</p>}
    {proposal && <>
      <p>{applied ? "需要回退时，可在编辑器撤销。" : stale ? "工程已变化，这份建议已过期。请重新提出要求。" : "先看看改了什么，确认后再写入工程。"}</p>
      <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? "收起差异" : "查看修改差异"}</button>
      {open && <div className="lac-diff" onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false); } }}>
        <ol>{proposal.changes.map((change, index) => <li key={index}><strong>{change.label}</strong><div className="lac-before">原来：{changeValue(change.before)}</div><div>改为：{changeValue(change.after)}</div>
          {change.timeMs !== undefined && onSeek && <button type="button" onClick={() => onSeek(change.timeMs!)}>定位到 {(change.timeMs / 1000).toFixed(1)} 秒</button>}
          <details><summary>技术细节</summary><small>{change.path}</small><pre>{JSON.stringify({ before: change.before, after: change.after }, null, 2)}</pre></details>
        </li>)}</ol>
        <button type="button" className="lac-primary" disabled={readOnly || stale || applied || used.has(event.sequence)} title={readOnly ? "当前只读查看历史，请先继续此对话" : applied ? "本提案已应用" : used.has(event.sequence) ? "已提交过，请先检查工程" : stale ? "工程变化后需要重新生成提案" : "一次提交全部修改，可撤销"} onClick={apply}>{applied ? "已应用" : used.has(event.sequence) ? "提交状态待确认" : "确认应用修改"}</button>
      </div>}
    </>}
  </section>;
}
export function LocalAgentChat({ project, kind, context, onApply, onSeek, className = "", draftRequest, beforeSend }: LocalAgentChatProps) {
  const chat = useLocalAgentChat(project, kind, context);
  const [draft, setDraft] = useState(""), [activity, setActivity] = useState(false), [historyOpen, setHistoryOpen] = useState(false);
  const [historyAgent, setHistoryAgent] = useState("all");
  const composing = useRef(false), log = useRef<HTMLDivElement>(null), follow = useRef(true);
  const selected = chat.catalog.agents.find(agent => agent.id === chat.agentId);
  const connected = !chat.readOnly && (chat.state === "idle" || chat.state === "running");
  const canSend = connected && chat.state === "idle" && !chat.busy && !chat.pollFailed && Boolean(draft.trim());
  const conversations = chat.projectConversations.filter(item => historyAgent === "all" || item.agentId === historyAgent);
  const historyDate = (value?: number) => value ? new Date(value).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : "较早对话";
  const visibleOptimistic = chat.optimistic && !chat.projected.messages.some(message => message.id === `user-${chat.optimistic?.turnId}`);
  const send = () => {
    if (!canSend || composing.current) return;
    try { beforeSend?.(); } catch (cause) { chat.reportError(cause instanceof Error ? cause.message : "请求已过期，请重新核对。"); return; }
    const text = draft; setDraft(""); void chat.send(text);
  };
  useEffect(() => { setDraft(""); setActivity(false); follow.current = true; }, [project.id, kind, chat.agentId, chat.conversationId]);
  useEffect(() => { if (draftRequest) setDraft(draftRequest.text); }, [draftRequest?.id]);
  useEffect(() => { if (follow.current && log.current) log.current.scrollTop = log.current.scrollHeight; }, [chat.projected.messages, chat.optimistic, chat.projected.requests]);
  return <section className={`local-agent-chat ${className}`} aria-label="本地智能体聊天" onKeyDown={event => {
    if (event.key !== "Escape") return;
    setActivity(false); setHistoryOpen(false);
    for (const detail of event.currentTarget.querySelectorAll("details[open]")) detail.removeAttribute("open");
    const expanded = event.currentTarget.querySelector<HTMLButtonElement>('.lac-proposal button[aria-expanded="true"]'); expanded?.click();
  }}>
    <header className="lac-head"><div><strong>本地智能体</strong><span className={`lac-state ${chat.state === "idle" ? "is-ready" : ""}`} role="status"><i aria-hidden="true" />{stateLabel(chat.state)}</span></div>
      <button type="button" className="lac-icon-button" title="刷新本机智能体列表" disabled={Boolean(chat.busy) || connected} onClick={() => void chat.refresh()}>刷新检测</button></header>
    {!chat.available ? <div className="lac-empty"><strong>在桌面版继续聊</strong><p>本地智能体需要桌面连接。浏览器里仍可使用 API 模型。</p></div> : <>
      <div className="lac-conversation-actions"><button type="button" aria-expanded={historyOpen} onClick={() => { const open = !historyOpen; setHistoryOpen(open); if (open) void chat.refresh(); }}>历史对话</button><button type="button" disabled={!selected?.installed || !selected.enabled || Boolean(chat.busy)} title={chat.busy ? "当前连接操作结束后可创建" : "创建独立对话，不终止其他任务"} onClick={() => { setHistoryOpen(false); void chat.connect(true); }}>新对话</button></div>
      {historyOpen && <section className="lac-history" aria-label="历史对话面板"><div className="lac-row"><strong>本工程的对话</strong><button type="button" onClick={() => setHistoryOpen(false)}>关闭历史</button></div>
        <label>筛选智能体<select aria-label="历史对话智能体" value={historyAgent} onChange={event => setHistoryAgent(event.target.value)}><option value="all">全部智能体</option>{chat.catalog.agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
        {chat.loading && <p role="status">正在读取对话列表…</p>}
        {!chat.loading && !conversations.length && <p>还没有历史对话。点击「新对话」开始。</p>}
        <ol>{conversations.map(item => <li key={item.conversationId}><button type="button" aria-current={item.conversationId === chat.conversationId ? "true" : undefined} onClick={() => { chat.selectConversation(item); setHistoryOpen(false); }}><strong>{cleanText(item.title) || "未命名对话"}</strong><span>{chat.catalog.agents.find(agent => agent.id === item.agentId)?.name ?? item.agentId} · {historyDate(item.updatedAt)}</span><small className={item.state === "running" ? "lac-task-running" : ""}>{item.state === "running" ? "进行中 · 后台继续执行" : stateLabel(item.state)}</small></button></li>)}</ol>
      </section>}
      {chat.readOnly && <p className="lac-hint" role="status">正在只读查看历史。{chat.state === "running" ? "原任务仍在进行；点击「继续此任务」返回操作。" : "点击「恢复连接」后继续这段对话。"}</p>}
      <div className="lac-controls"><label>智能体<select aria-label="聊天智能体" value={chat.agentId} disabled={Boolean(chat.busy)} onChange={event => chat.setAgentId(event.target.value)}>
        {!chat.catalog.agents.length && <option value="">{chat.loading ? "正在检测…" : "未发现智能体"}</option>}
        {chat.catalog.agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}{!agent.installed ? " · 未安装" : !agent.enabled ? " · 未启用" : ""}</option>)}</select></label>
        {!connected && <button type="button" disabled={!selected?.installed || !selected.enabled || Boolean(chat.busy) || chat.uncertainPrompt} title={!selected?.installed ? "请先安装并在设置中检测智能体" : !selected.enabled ? "请先在连接设置中启用智能体" : "连接本机智能体，不会重发历史要求"} onClick={() => void chat.connect()}>{chat.busy === "connect" ? "连接中…" : chat.readOnly && chat.state === "running" ? "继续此任务" : chat.conversationId ? "恢复连接" : "开始对话"}</button>}
        {connected && <button type="button" disabled={Boolean(chat.busy)} title="断开后仍可恢复对话" onClick={() => void chat.stop("disconnect")}>断开</button>}
        {chat.models.map(model => <label key={model.id}>模型<select aria-label={`智能体模型 ${model.name}`} value={model.currentValue} disabled={chat.readOnly || chat.state !== "idle" || Boolean(chat.busy)} title={chat.state !== "idle" ? "本轮结束后可切换模型" : "由智能体提供的可用模型"} onChange={event => void chat.setConfig(model.id, event.target.value)}>{configChoices(model).map(option => <option key={option.value} value={option.value}>{option.name}</option>)}</select></label>)}
      </div>
      {selected && (!selected.installed || !selected.enabled) && <p className="lac-hint">{!selected.installed ? "先安装官方智能体，再到连接设置中检测。" : "请先在连接设置中启用这个智能体。"}</p>}
      <div ref={log} className="lac-log" role="log" aria-label="本地智能体对话记录" aria-live="polite" aria-relevant="additions text" onScroll={() => { const element = log.current!; follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 72; }}>
        {(chat.historyPage.hasMore || chat.historyLoading || chat.historyError) && <div className="lac-history-page"><button type="button" disabled={chat.historyLoading} title="从本机历史读取，不会重发要求" onClick={() => { follow.current = false; void chat.loadHistory(true); }}>{chat.historyLoading ? "正在读取记录…" : chat.historyError ? "重试读取更早记录" : "查看更早记录"}</button>{chat.historyError && <p role="alert">{chat.historyError}</p>}</div>}
        {chat.historyPage.incomplete && <p className="lac-hint">部分早期记录未完整保留；已保存的记录仍可读取。</p>}
        {!chat.projected.messages.length && !visibleOptimistic && <div className="lac-empty"><span className="lac-empty-mark" aria-hidden="true">↗</span><strong>说说你想怎么改</strong><p>{kind === "scene" ? "精简旁白、调整节奏，或先一起推敲某个镜头。" : "调整片段、打磨字幕，或先聊聊时间线怎么剪。"}</p><small>修改先出建议，由你确认后应用。</small></div>}
        {chat.projected.messages.map(message => <article key={message.id} className={`lac-message is-${message.role}`}><small>{message.role === "user" ? "你" : selected?.name ?? "智能体"}</small><div>{message.text}</div></article>)}
        {visibleOptimistic && <article className="lac-message is-user"><small>你</small><div>{chat.optimistic!.text}</div></article>}
        {chat.state === "running" && <p className="lac-working" role="status"><i aria-hidden="true" />{chat.projected.requests.length ? "等待你的回答" : "正在思考和回复…"}</p>}
        {!chat.readOnly && chat.state === "running" && chat.projected.requests.map(card => <RequestForm key={card.requestId} card={card} disabled={Boolean(chat.busy)} answer={payload => void chat.answer(card.requestId, payload)} />)}
        {chat.projected.proposals.map(event => event.project ? <ProposalPreview key={`${chat.conversationId}-${event.sequence}`} event={event} capture={chat.proposalCapture(event.turnId)} project={project} kind={kind} used={chat.applying.current.get(chat.conversationId)!} readOnly={chat.readOnly} onApply={onApply} onSeek={onSeek} report={chat.report} /> : <p key={`proposal-${event.sequence}`} className="lac-hint">历史中曾生成一份修改建议。工程快照未保存在聊天历史中，继续对话后可重新生成。</p>)}
      </div>
      {chat.projected.tools.length > 0 && <div className="lac-activity"><button type="button" aria-expanded={activity} onClick={() => setActivity(value => !value)}>{activity ? "收起" : "查看"}工具活动 · {chat.projected.tools.length}</button>{activity && <ol>{chat.projected.tools.map(tool => <li key={tool.toolCallId}><strong>{cleanText(tool.title) || "工具操作"}</strong><span>{({ completed: "已完成", failed: "未完成", in_progress: "进行中", pending: "等待中" } as Record<string, string>)[tool.status ?? ""] ?? "活动记录"}</span><details><summary>技术细节</summary><pre>{JSON.stringify(tool, null, 2)}</pre></details></li>)}</ol>}</div>}
      {chat.notice && <p className="lac-hint" role="status">{chat.notice}</p>}
      {chat.error && <div className="lac-error" role="alert"><p>{chat.error}</p>{(chat.pollFailed || chat.uncertainPrompt) && <button type="button" onClick={chat.retryPoll}>重新读取对话</button>}</div>}
      <form className="lac-composer" onSubmit={event => { event.preventDefault(); send(); }}><label className="lac-sr-only" htmlFor={`lac-input-${kind}-${project.id}`}>发给本地智能体</label>
        <textarea id={`lac-input-${kind}-${project.id}`} aria-label="发给本地智能体" value={draft} rows={3} maxLength={CHAT_TEXT_LIMIT} placeholder={connected ? "想改哪里？也可以先问问它的想法…" : "连接后，就能在这里继续聊…"} onChange={event => setDraft(event.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229 && !composing.current) { event.preventDefault(); send(); } }} />
        <div className="lac-compose-foot"><small>Enter 发送 · Shift + Enter 换行</small>{!chat.readOnly && (chat.state === "running" || chat.busy === "prompt") ? <button type="button" className="lac-cancel" onClick={() => void chat.stop("cancel")}>取消本次</button> : <button type="submit" className="lac-primary" disabled={!canSend} title={chat.pollFailed ? "先重新读取对话" : !connected ? "请先连接本地智能体" : !draft.trim() ? "先写下你的想法" : "发送给本地智能体"}>发送 <span aria-hidden="true">↑</span></button>}</div>
      </form>
      <details className="lac-connection"><summary>连接详情</summary><small>聊天记录保存在本机；切换视图不会重发要求。登录和凭据由官方智能体管理。</small>{selected?.path && <pre>{selected.path}</pre>}{chat.conversationId && <pre>{chat.conversationId}</pre>}</details>
    </>}
  </section>;
}
