import { useEffect, useMemo, useRef, useState } from "react";
import { localAgentRequest, isLocalAgentAvailable } from "./local-agent-client";
import { CHAT_POLL_MS, mergeEvents, projectEvents, type AgentEvent, type ChatContext, type ChatKind, type ChatList, type ChatProject, type ConfigOption, type ConnectResult, type Conversation, type EventsResult, type HistoryResult } from "./local-agent-chat-model";
import { captureChatContext, captureProject, type ChatProposal, type ChatTurnCapture } from "./local-agent-chat-proposal";

const failure = (cause: unknown) => cause instanceof Error ? cause.message : "本地智能体未响应，请检查连接后重试。";
// In-memory receipts survive panel remounts without storing project data or credentials.
const appliedProposals = new Map<string, Set<number>>();
const selectedConversations = new Map<string, string>();
const HISTORY_PAGE_SIZE = 50;
export function useLocalAgentChat(project: ChatProject, kind: ChatKind, context?: ChatContext) {
  const available = isLocalAgentAvailable();
  const [catalog, setCatalog] = useState<ChatList>({ agents: [], conversations: [] });
  const [agentId, setAgentId] = useState("");
  const [conversationId, setConversationId] = useState("");
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [state, setState] = useState("disconnected");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(available);
  const [models, setModels] = useState<ConfigOption[]>([]);
  const [optimistic, setOptimistic] = useState<{ text: string; turnId?: string } | null>(null);
  const [uncertainPrompt, setUncertainPrompt] = useState(false);
  const [pollRetry, setPollRetry] = useState(0);
  const [pollFailed, setPollFailed] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const [historyPage, setHistoryPage] = useState<{ nextBefore: string | null; hasMore: boolean; incomplete: boolean }>({ nextBefore: null, hasMore: false, incomplete: false });
  const [historyLoading, setHistoryLoading] = useState(false), [historyError, setHistoryError] = useState("");
  const historyGate = useRef(false), historyStamp = useRef(0), historyLoaded = useRef(false);
  const selectionKey = `${project.id}:${kind}:${agentId}`;
  const latest = useRef({ project, context }); latest.current = { project, context };
  const life = useRef(0), mutation = useRef(0), gate = useRef(false), forced = useRef<string | null>(null);
  const phase = useRef(state); phase.current = state;
  const captures = useRef(new Map<string, ChatTurnCapture>());
  const conversationCaptures = useRef(new Map<string, Map<string, ChatTurnCapture>>());
  const applying = useRef(appliedProposals);
  if (!applying.current.has(conversationId)) applying.current.set(conversationId, new Set());
  const pendingSnapshot = useRef<{ capture: ChatTurnCapture; text: string; afterSequence: number | undefined } | null>(null);
  const recovery = useRef(false);
  const readOnlySelections = useRef(new Set<string>());
  const selectedId = useRef(conversationId); selectedId.current = conversationId;
  const lastSequence = useRef<number | undefined>(undefined);
  const recoverPendingCapture = (incoming: AgentEvent[]) => {
    const pending = pendingSnapshot.current;
    if (!pending || pending.afterSequence === undefined) return;
    const afterSequence = pending.afterSequence;
    const started = incoming.find(event => event.type === "turn-started" && event.turnId && event.sequence > afterSequence && event.text === pending.text && !captures.current.has(event.turnId));
    if (!started?.turnId) return;
    captures.current.set(started.turnId, pending.capture); pendingSnapshot.current = null;
    setOptimistic(current => current ? { ...current, turnId: started.turnId } : current);
  };
  const projected = useMemo(() => projectEvents(events), [events]);
  const projectConversations = useMemo(() => (catalog.conversations ?? []).filter(item => item.projectId === project.id && item.kind === kind).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)), [catalog.conversations, project.id, kind]);
  const resetView = () => {
    mutation.current++; historyStamp.current++; gate.current = false; historyGate.current = false; forced.current = null; recovery.current = false;
    setEvents([]); setModels([]); setOptimistic(null); setUncertainPrompt(false); setError(""); setNotice(""); setBusy(""); setPollFailed(false);
    setHistoryPage({ nextBefore: null, hasMore: false, incomplete: false }); historyLoaded.current = false; setHistoryLoading(false); setHistoryError("");
    captures.current = new Map(); pendingSnapshot.current = null; lastSequence.current = undefined;
  };
  const selectConversation = (conversation: Conversation) => {
    if (conversation.projectId !== project.id || conversation.kind !== kind) return;
    selectedConversations.set(`${project.id}:${kind}:${conversation.agentId}`, conversation.conversationId);
    readOnlySelections.current.add(conversation.conversationId);
    resetView(); selectedId.current = conversation.conversationId; setAgentId(conversation.agentId); setConversationId(conversation.conversationId); setState(conversation.state); setReadOnly(true);
    setPollRetry(value => value + 1); setNotice("正在查看历史记录；未连接或重发要求。其他任务会继续运行。");
  };
  const loadHistory = async (earlier = false) => {
    if (!conversationId || historyGate.current || earlier && !historyPage.hasMore) return;
    historyGate.current = true; const stamp = historyStamp.current, alive = life.current, id = conversationId;
    setHistoryLoading(true); setHistoryError("");
    try {
      const result = await localAgentRequest<HistoryResult>({ action: "history", conversationId: id, limit: HISTORY_PAGE_SIZE, ...(earlier && historyPage.nextBefore ? { before: historyPage.nextBefore } : {}) });
      if (stamp !== historyStamp.current || alive !== life.current || selectedId.current !== id) return;
      if (!Array.isArray(result.events) || typeof result.hasMore !== "boolean") throw new Error("历史记录格式无效，请重新读取。");
      recoverPendingCapture(result.events);
      setEvents(current => mergeEvents(current, result.events)); historyLoaded.current = true;
      setHistoryPage({ nextBefore: result.nextBefore, hasMore: result.hasMore, incomplete: result.incomplete });
    } catch (cause) { if (stamp === historyStamp.current && alive === life.current && selectedId.current === id) setHistoryError(`历史读取失败：${failure(cause)}`); }
    finally { if (stamp === historyStamp.current && alive === life.current && selectedId.current === id) { historyGate.current = false; setHistoryLoading(false); } }
  };
  const refresh = async () => {
    if (!available) return;
    const stamp = life.current;
    setLoading(true); setError("");
    try {
      const result = await localAgentRequest<ChatList>({ action: "list" });
      if (stamp !== life.current) return;
      if (!Array.isArray(result.agents)) throw new Error("智能体列表无效，请刷新检测。");
      setCatalog(result);
      setAgentId(current => result.agents.some(agent => agent.id === current) ? current : (result.agents.find(agent => agent.enabled && agent.installed) ?? result.agents[0])?.id ?? "");
    } catch (cause) { if (stamp === life.current) setError(failure(cause)); }
    finally { if (stamp === life.current) setLoading(false); }
  };
  useEffect(() => { void refresh(); return () => { life.current++; mutation.current++; }; }, []);
  useEffect(() => {
    const saved = selectedConversations.get(selectionKey);
    const matches = projectConversations.filter(item => item.agentId === agentId);
    const known = matches.find(item => item.conversationId === saved) ?? matches[0];
    resetView(); setConversationId(known?.conversationId ?? ""); setState(known?.state ?? "disconnected");
    setReadOnly(Boolean(known && readOnlySelections.current.has(known.conversationId)));
    if (known) selectedConversations.set(selectionKey, known.conversationId);
  }, [agentId, project.id, kind]);
  useEffect(() => {
    if (!conversationId) return;
    let saved = conversationCaptures.current.get(conversationId);
    if (!saved) { saved = new Map(); conversationCaptures.current.set(conversationId, saved); }
    captures.current = saved;
    void loadHistory();
  }, [conversationId, pollRetry]);
  useEffect(() => {
    if (!conversationId || pollFailed) return;
    let stopped = false, cursor = 0, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const stamp = mutation.current;
      try {
        const result = await localAgentRequest<EventsResult>({ action: "events", conversationId, after: cursor });
        if (stopped) return;
        if (!Array.isArray(result.events) || !Number.isSafeInteger(result.lastSequence)) throw new Error("会话事件无效，请重新读取记录。");
        cursor = result.lastSequence; lastSequence.current = result.lastSequence;
        if (recovery.current) { recovery.current = false; forced.current = null; setUncertainPrompt(false); setNotice("已重新读取对话，原要求不会重发。请查看回复再决定下一步。"); }
        recoverPendingCapture(result.events);
        setEvents(current => result.events.length ? mergeEvents(current, result.events) : current);
        if (!forced.current && !gate.current && stamp === mutation.current) setState(result.state);
        setCatalog(current => ({ ...current, conversations: current.conversations?.map(item => item.conversationId === conversationId ? { ...item, state: result.state, lastSequence: result.lastSequence } : item) }));
        if (result.truncated && !historyLoaded.current) setHistoryPage(current => ({ ...current, hasMore: true }));
        timer = setTimeout(() => void poll(), CHAT_POLL_MS);
      } catch (cause) {
        if (!stopped) { setError(`读取对话中断：${failure(cause)} 不会自动重发要求。`); setPollFailed(true); }
      }
    };
    void poll(); return () => { stopped = true; clearTimeout(timer); };
  }, [conversationId, pollRetry, pollFailed]);
  useEffect(() => { if (projected.models) setModels(projected.models.filter(option => option.category === "model")); }, [projected.models]);
  useEffect(() => {
    if (optimistic && projected.messages.some(message => message.role === "user" && message.id === `user-${optimistic.turnId}`)) setOptimistic(null);
  }, [projected.messages, optimistic]);
  const connect = async (newConversation = false) => {
    if (gate.current || !agentId) return;
    if (!newConversation && conversationId && readOnly && ["idle", "running"].includes(state)) {
      readOnlySelections.current.delete(conversationId); setReadOnly(false); setNotice(state === "running" ? "已回到进行中的任务，没有重发要求。" : "已回到这段对话，可以继续聊。"); return;
    }
    if (newConversation) { resetView(); setConversationId(""); selectedId.current = ""; }
    gate.current = true; const stamp = ++mutation.current, alive = life.current;
    forced.current = "connecting"; setState("connecting"); setBusy("connect"); setError(""); setNotice(newConversation ? "正在创建新对话，其他任务不受影响…" : "正在连接本机智能体…");
    try {
      const result = await localAgentRequest<ConnectResult>({ action: "connect", agentId, projectId: project.id, kind,
        snapshot: captureProject(latest.current.project), context: captureChatContext(latest.current.context), ...(newConversation ? { newConversation: true } : conversationId ? { conversationId } : {}) });
      if (stamp !== mutation.current || alive !== life.current) return;
      forced.current = null; setConversationId(result.conversationId); setState(result.state); setReadOnly(false);
      readOnlySelections.current.delete(result.conversationId); selectedConversations.set(selectionKey, result.conversationId);
      setCatalog(current => ({ ...current, conversations: [...(current.conversations ?? []).filter(item => item.conversationId !== result.conversationId), { conversationId: result.conversationId, agentId, projectId: project.id, kind, title: project.title, updatedAt: Date.now(), state: result.state, lastSequence: 0 }] }));
      setModels((result.modelOptions ?? result.configOptions ?? []).filter(option => option.category === "model"));
      setNotice(newConversation ? "新对话已就绪，原任务仍在历史对话中。" : conversationId ? "已恢复对话。原要求不会重发。" : "已连接，可以开始聊了。");
      setPollFailed(false); setPollRetry(value => value + 1);
    } catch (cause) { if (stamp === mutation.current && alive === life.current) { forced.current = "error"; setState("error"); setError(failure(cause)); } }
    finally { if (stamp === mutation.current && alive === life.current) { gate.current = false; setBusy(""); } }
  };
  const send = async (text: string): Promise<boolean> => {
    text = text.trim();
    if (gate.current || readOnly || phase.current !== "idle" || !conversationId || !text || pollFailed) return false;
    gate.current = true; const stamp = ++mutation.current, alive = life.current;
    const snapshot = captureProject(latest.current.project), context = captureChatContext(latest.current.context);
    const capture: ChatTurnCapture = { project: snapshot, context };
    pendingSnapshot.current = { capture, text, afterSequence: lastSequence.current };
    const ownedCaptures = captures.current;
    phase.current = "running"; setState("running"); setBusy("prompt"); setError(""); setNotice(""); setOptimistic({ text });
    try {
      const result = await localAgentRequest<{ turnId: string }>({ action: "prompt", conversationId, text, snapshot, context: captureChatContext(context) });
      ownedCaptures.set(result.turnId, capture);
      if (stamp !== mutation.current || alive !== life.current) return true;
      pendingSnapshot.current = null;
      setOptimistic({ text, turnId: result.turnId }); return true;
    } catch (cause) {
      if (stamp === mutation.current && alive === life.current) {
        forced.current = "error"; setState("error"); setUncertainPrompt(true); setError(`${failure(cause)} 为避免重复执行，未自动重试；请先读取对话，再决定是否重新发送。`);
        setNotice("要求可能已到达智能体，发送记录保留在下方。");
      }
      return true;
    } finally { if (stamp === mutation.current && alive === life.current) { gate.current = false; setBusy(""); } }
  };
  const stop = async (action: "cancel" | "disconnect") => {
    if (!conversationId || readOnly) return;
    const stamp = ++mutation.current, alive = life.current;
    gate.current = true; forced.current = action === "cancel" ? "cancelled" : "disconnected";
    phase.current = forced.current; setState(forced.current); setBusy(action); setError("");
    setNotice(action === "cancel" ? "已停止等待，正在终止本次任务。恢复连接后可继续聊。" : "正在断开本机连接，对话记录会保留。");
    try {
      const result = await localAgentRequest<{ treeStopped?: boolean }>({ action, conversationId });
      if (stamp !== mutation.current || alive !== life.current) return;
      setNotice(result.treeStopped === false ? "已停止等待，但本机进程可能尚未退出，请检查后再恢复连接。" : action === "cancel" ? "本次任务已取消，工程未修改。恢复连接后可继续。" : "已断开连接，对话记录已保留。");
    } catch (cause) { if (stamp === mutation.current && alive === life.current) setError(`终止尚未确认：${failure(cause)} 请检查本机进程。`); }
    finally { if (stamp === mutation.current && alive === life.current) { gate.current = false; setBusy(""); } }
  };
  const answer = async (requestId: string, payload: { optionId?: string; answers?: Record<string, unknown> }) => {
    if (gate.current || readOnly || phase.current !== "running") return;
    gate.current = true; const stamp = mutation.current, alive = life.current; setBusy(requestId); setError("");
    try {
      await localAgentRequest({ action: "answer", conversationId, requestId, ...payload });
      if (stamp === mutation.current && alive === life.current) { setNotice("回答已送达，智能体将继续。"); setEvents(current => current.map(event => event.requestId === requestId && event.type === "request" ? { ...event, type: "request-answered" } : event)); }
    } catch (cause) { if (stamp === mutation.current && alive === life.current) setError(failure(cause)); }
    finally { if (stamp === mutation.current && alive === life.current) { gate.current = false; setBusy(""); } }
  };
  const setConfig = async (configId: string, value: string) => {
    if (gate.current || readOnly || phase.current !== "idle") return;
    gate.current = true; const stamp = mutation.current, alive = life.current; setBusy("config"); setError("");
    try {
      const result = await localAgentRequest<ConnectResult>({ action: "setConfig", conversationId, configId, value });
      if (stamp === mutation.current && alive === life.current) { setModels((result.modelOptions ?? result.configOptions ?? []).filter(option => option.category === "model")); setNotice("模型已切换。"); }
    } catch (cause) { if (stamp === mutation.current && alive === life.current) setError(failure(cause)); }
    finally { if (stamp === mutation.current && alive === life.current) { gate.current = false; setBusy(""); } }
  };
  return { available, catalog, agentId, setAgentId, conversationId, state, busy, error, notice, loading, models, projected, optimistic, uncertainPrompt,
    captures, pendingSnapshot, applying, connect, send, stop, answer, setConfig, refresh,
    projectConversations, selectConversation, readOnly, historyPage, historyLoading, historyError, loadHistory,
    pollFailed, retryPoll: () => { recovery.current = true; setError(""); setPollFailed(false); setPollRetry(value => value + 1); },
    report: (message: string) => setNotice(message), reportError: (message: string) => setError(message),
    proposalCapture: (turnId?: string): ChatTurnCapture | undefined => turnId ? captures.current.get(turnId) : undefined,
  };
}
export type LocalAgentChatController = ReturnType<typeof useLocalAgentChat>;
export type ApplyChatProposal = (proposal: ChatProposal) => void;
