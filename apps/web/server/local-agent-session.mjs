import { randomUUID } from "node:crypto";
import { openAcpProcess } from "./local-agent-process.mjs";
import { createRequestCards } from "./local-agent-requests.mjs";
import { parseSnapshot, prepareWorkspace, proposalPrompt, collectProposal } from "./local-agent-proposals.mjs";
import { appendEvent } from "./local-agent-store.mjs";
import { demand, errorResult, LIMITS, LocalAgentError } from "./local-agent-common.mjs";

const unsafeConfig = value => /bypass|allow[-_ ]?all|yolo|danger|full[-_ ]?access|skip[-_ ]?permission|dontask|auto[-_ ]?approve/i.test(String(value));
export function createLocalAgentSession(record, store, options = {}) {
  let transport, epoch = 0, activeTurn = null, closing = false, configOptions = [], info = null;
  const directory = store.workspace(record.id);
  const emit = event => {
    appendEvent(record, event);
    void store.save().catch(() => { record.state = "error"; });
  };
  const cards = createRequestCards({ emit, active: () => !!activeTurn && !closing, timeoutMs: options.permissionTimeoutMs });
  const valid = stamp => stamp === epoch && !closing;
  async function stop(state = "disconnected") {
    closing = true; ++epoch; cards.clear(); activeTurn = null;
    const owned = transport; transport = undefined;
    if (owned && record.sessionId) void owned.notify("session/cancel", { sessionId: record.sessionId }).catch(() => {});
    const treeStopped = owned ? await owned.stop() : true;
    record.state = state; emit({ type: "state", state, treeStopped }); await store.save(); return { state, treeStopped };
  }
  async function connect(command, snapshot, context) {
    closing = false; const stamp = ++epoch;
    record.state = "connecting"; emit({ type: "state", state: record.state });
    try {
      const base = parseSnapshot(record.kind, snapshot, record.projectId);
      await prepareWorkspace(directory, record.kind, base, context);
      demand(valid(stamp), "cancelled", "连接已取消。");
      const opened = await openAcpProcess(command, directory, {
        update(params) {
          if (!valid(stamp) || (record.sessionId && params.sessionId !== record.sessionId)) return;
          if (params.update.sessionUpdate === "config_option_update") configOptions = params.update.configOptions ?? [];
          emit({ type: "update", update: params.update });
        },
        permission(params, signal) { return !record.sessionId || params.sessionId === record.sessionId ? cards.permission(params, signal) : { outcome: { outcome: "cancelled" } }; },
        elicitation(params, signal) { return !params.sessionId || params.sessionId === record.sessionId ? cards.elicitation(params, signal) : { action: "cancel" }; },
        exit(message) { if (valid(stamp)) { emit({ type: "error", code: "process-exit", message }); void stop("error").catch(() => {}); } },
      }, options);
      if (!valid(stamp)) { await opened.stop(); throw new LocalAgentError("cancelled", "连接已取消。"); }
      transport = opened;
      const initialized = await transport.call("initialize", { protocolVersion: transport.sdk.PROTOCOL_VERSION,
        clientInfo: { name: "glint", version: "1" }, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, elicitation: { form: {} } } });
      demand(initialized.protocolVersion === transport.sdk.PROTOCOL_VERSION, "protocol-version", "代理 ACP 协议版本不兼容，请更新官方适配器。");
      info = initialized.agentInfo ?? null;
      let result;
      if (record.sessionId) {
        const caps = initialized.agentCapabilities;
        const method = caps?.sessionCapabilities?.resume != null ? "session/resume" : caps?.loadSession ? "session/load" : null;
        demand(method, "resume-unsupported", "该代理不支持恢复旧会话；不会自动创建会话或重发原要求。");
        result = await transport.call(method, { sessionId: record.sessionId, cwd: directory, mcpServers: [] });
      } else {
        result = await transport.call("session/new", { cwd: directory, mcpServers: [] });
        demand(typeof result.sessionId === "string" && result.sessionId.length <= 1024, "invalid-session", "代理没有返回有效 ACP session id。");
        record.sessionId = result.sessionId;
      }
      demand(valid(stamp), "cancelled", "连接已取消。");
      configOptions = result.configOptions ?? [];
      for (const [configId, value] of Object.entries(record.choices ?? {})) if (configOptions.some(item => item.id === configId)) await setConfig({ configId, value });
      record.state = "idle"; emit({ type: "connected", info, resumed: !!result && !!record.resumed, modelOptions: models().modelOptions });
      record.resumed = true; await store.save(); return { conversationId: record.id, info, ...models(), state: record.state };
    } catch (error) {
      const result = errorResult(error);
      if (valid(stamp)) emit({ type: "error", ...result.error });
      await stop(result.error.code === "login-required" ? "login-required" : result.error.code === "cancelled" ? "disconnected" : "error"); throw error;
    }
  }
  async function prompt({ text, snapshot, context }) {
    demand(transport && record.state === "idle" && !activeTurn && !closing, "busy-or-disconnected", "请等待当前回合结束或重新连接代理。");
    const base = parseSnapshot(record.kind, snapshot, record.projectId);
    const instruction = proposalPrompt(record.kind, text, context);
    const turnId = randomUUID(), stamp = epoch, owned = transport;
    activeTurn = turnId; record.state = "running";
    try {
      await prepareWorkspace(directory, record.kind, base, context);
      demand(valid(stamp) && activeTurn === turnId, "cancelled", "回合已取消。");
      emit({ type: "turn-started", turnId, text });
      // Intentionally detached: request returns before the ACP turn completes.
      void (async () => {
        try {
          const result = await owned.call("session/prompt", { sessionId: record.sessionId, prompt: [{ type: "text", text: instruction }] }, options.turnTimeoutMs ?? LIMITS.turnMs);
          if (!valid(stamp) || activeTurn !== turnId) return;
          const proposal = await collectProposal(directory, record.kind, base, context);
          if (!valid(stamp) || activeTurn !== turnId) return;
          if (proposal && result.stopReason === "end_turn") emit({ ...proposal, turnId });
          cards.clear(); activeTurn = null; record.state = "idle";
          emit({ type: "turn-ended", turnId, stopReason: result.stopReason, state: record.state });
        } catch (error) {
          if (!valid(stamp) || activeTurn !== turnId) return;
          emit({ type: "error", turnId, ...errorResult(error).error });
          await stop("error");
        }
      })().catch(() => { record.state = "error"; });
      return { conversationId: record.id, turnId, state: record.state };
    } catch (error) { if (valid(stamp)) { activeTurn = null; record.state = "idle"; } throw error; }
  }
  function models() { return { configOptions, modelOptions: configOptions.filter(item => item.category === "model") }; }
  async function setConfig({ configId, value }) {
    demand(transport && !activeTurn && !closing, "busy-or-disconnected", "修改模型配置前请结束回合并连接代理。");
    const config = configOptions.find(item => item.id === configId);
    const values = config?.options?.flatMap(item => item.options ?? [item]) ?? [];
    demand(config && (config.type === "boolean" ? typeof value === "boolean" : values.some(item => item.value === value)), "invalid-config", "请选择代理实际提供的模型配置值。");
    demand(!unsafeConfig(configId) && !unsafeConfig(value) && !/permission|approval|sandbox/i.test(configId) && config.category !== "mode", "unsafe-config", "不能通过模型设置放宽代理权限。");
    const stamp = epoch, owned = transport;
    const response = await owned.call("session/set_config_option", { sessionId: record.sessionId, configId, value });
    demand(valid(stamp), "cancelled", "配置修改已取消。");
    configOptions = response.configOptions ?? configOptions; record.choices[configId] = value;
    emit({ type: "config", configOptions }); await store.save(); return models();
  }
  return { connect, prompt, models, setConfig, answer: request => cards.answer(request),
    cancel: () => stop("cancelled"), disconnect: () => stop(), dispose: () => stop(), get connected() { return !!transport && !closing; } };
}
