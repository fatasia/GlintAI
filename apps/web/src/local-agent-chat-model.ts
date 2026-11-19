import type { NleProject, SceneScriptProject } from "@glintai/scenescript";
import type { LocalAgent } from "./local-agent-client";
import type { ArtifactProject, ArtifactSelection } from "./artifact-project";

export type ChatProject = SceneScriptProject | NleProject | ArtifactProject;
export type ChatKind = "scene" | "nle" | "design" | "script";
export type ChatContext = { sceneId?: string; clipIds?: string[]; timeMs?: number; range?: unknown; selection?: ArtifactSelection; document?: { id: string; title?: string; content: string; selection?: { text: string; start: number; end: number } } };
export type Conversation = { conversationId: string; agentId: string; projectId: string; kind: ChatKind; state: string; lastSequence: number; title?: string; updatedAt?: number };
export type ConfigChoice = { value: string; name: string };
export type ConfigOption = { id: string; name: string; category?: string; type?: string; currentValue: string; options?: Array<ConfigChoice | { name: string; options: ConfigChoice[] }> };
export type AgentEvent = {
  sequence: number; at?: number; type: string; state?: string; turnId?: string; text?: string;
  message?: string; code?: string; update?: AgentUpdate; info?: { name?: string; version?: string };
  modelOptions?: ConfigOption[]; configOptions?: ConfigOption[]; requestId?: string;
  requestType?: "permission" | "question"; options?: PermissionOption[]; toolCall?: ToolActivity;
  requestedSchema?: QuestionSchema; project?: unknown; baseDigest?: string;
};
export type AgentUpdate = { sessionUpdate: string; content?: { type: string; text?: string }; toolCallId?: string; title?: string; status?: string; kind?: string; rawInput?: unknown; rawOutput?: unknown; configOptions?: ConfigOption[]; entries?: Array<{ content: string; status: string }> };
export type ToolActivity = { toolCallId: string; title?: string; status?: string; kind?: string; rawInput?: unknown; rawOutput?: unknown };
export type PermissionOption = { optionId: string; name: string; kind: string };
export type QuestionField = { type: string; title?: string; description?: string; enum?: Array<string | number | boolean>; enumNames?: string[]; items?: { enum?: string[] }; minimum?: number; maximum?: number; minLength?: number; maxLength?: number; minItems?: number; maxItems?: number; default?: unknown };
export type QuestionSchema = { type?: string; required?: string[]; properties?: Record<string, QuestionField> };
export type ConnectResult = { conversationId: string; state: string; info?: { name?: string; version?: string }; modelOptions?: ConfigOption[]; configOptions?: ConfigOption[] };
export type EventsResult = { events: AgentEvent[]; lastSequence: number; state: string; truncated?: boolean };
export type HistoryResult = { events: AgentEvent[]; nextBefore: string | null; hasMore: boolean; incomplete: boolean; state: string };
export type ChatList = { agents: LocalAgent[]; conversations?: Conversation[] };
export type ChatMessage = { id: string; role: "user" | "assistant"; text: string };
export type RequestCard = AgentEvent & { requestId: string; requestType: "permission" | "question" };

export const CHAT_POLL_MS = 500;
export const CHAT_TEXT_LIMIT = 32_000;
export const stateLabel = (state: string) => ({ idle: "已连接", running: "正在回复", connecting: "连接中", cancelled: "已取消 · 需恢复连接", disconnected: "未连接", error: "连接异常", "login-required": "需要本机登录" }[state] ?? "未连接");
export const cleanText = (text: unknown) => typeof text === "string" ? text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "") : "";
export function configChoices(config: ConfigOption): ConfigChoice[] {
  return (config.options ?? []).flatMap(option => "options" in option ? option.options : [option]);
}
export function mergeEvents(previous: AgentEvent[], incoming: AgentEvent[]): AgentEvent[] {
  const merged = new Map(previous.map(event => [event.sequence, event]));
  for (const event of incoming) if (Number.isSafeInteger(event.sequence) && event.sequence > 0 && typeof event.type === "string") {
    const existing = merged.get(event.sequence);
    merged.set(event.sequence, existing ? { ...existing, ...event, project: event.project ?? existing.project, options: event.options ?? existing.options, requestedSchema: event.requestedSchema ?? existing.requestedSchema, toolCall: event.toolCall ?? existing.toolCall, update: event.update ? { ...existing.update, ...event.update } : existing.update } : event);
  }
  return [...merged.values()].sort((a, b) => a.sequence - b.sequence);
}

/** Rebuild visible history from the host's journal; never infer or replay a prompt. */
export function projectEvents(events: AgentEvent[]) {
  const messages: ChatMessage[] = [], tools = new Map<string, ToolActivity>(), requests = new Map<string, RequestCard>();
  const proposals: AgentEvent[] = [];
  let turn = "history", assistant: ChatMessage | undefined, models: ConfigOption[] | undefined;
  for (const event of events) {
    if (event.type === "turn-started") {
      turn = event.turnId ?? String(event.sequence); assistant = undefined;
      messages.push({ id: `user-${turn}`, role: "user", text: cleanText(event.text) });
    }
    if (event.type === "update") {
      const update = event.update;
      if (update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
        if (!assistant) { assistant = { id: `reply-${turn}-${event.sequence}`, role: "assistant", text: "" }; messages.push(assistant); }
        assistant.text += cleanText(update.content.text);
      }
      if (update && ["tool_call", "tool_call_update"].includes(update.sessionUpdate) && update.toolCallId) {
        const previous = tools.get(update.toolCallId);
        tools.set(update.toolCallId, { ...previous, ...update, toolCallId: update.toolCallId, title: update.title ?? previous?.title });
        assistant = undefined;
      }
      if (update?.sessionUpdate === "plan") {
        tools.set(`plan-${event.sequence}`, { toolCallId: `plan-${event.sequence}`, title: (update.entries ?? []).map(entry => cleanText(entry.content)).join("；"), status: "计划" });
      }
      if (update?.sessionUpdate === "config_option_update") models = update.configOptions;
    }
    if (event.type === "connected") models = event.modelOptions;
    if (event.type === "config") models = event.configOptions;
    if (event.type === "request" && event.requestId && event.requestType) requests.set(event.requestId, event as RequestCard);
    if (["request-answered", "request-expired"].includes(event.type) && event.requestId) requests.delete(event.requestId);
    if (event.type === "proposal") proposals.push(event);
    if (event.type === "turn-ended" || event.type === "state" && event.state !== "running") { requests.clear(); assistant = undefined; }
    if (event.type === "error") messages.push({ id: `error-${event.sequence}`, role: "assistant", text: cleanText(event.message) || "智能体未完成回复，请检查本机连接。" });
  }
  return { messages, tools: [...tools.values()], requests: [...requests.values()], proposals, models };
}
