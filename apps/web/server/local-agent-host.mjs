import { createCatalog, CATALOG, catalogEntry, resolveCommand } from "./local-agent-catalog.mjs";
import { createLocalAgentStore, createConversation, pollEvents } from "./local-agent-store.mjs";
import { createLocalAgentSession } from "./local-agent-session.mjs";
import { demand, errorResult, boundedJson, LIMITS } from "./local-agent-common.mjs";

/** Private local host, not an HTTP route or an arbitrary command execution API. */
export function createLocalAgentHost({ dataDir, adapters, ...options } = {}) {
  const store = createLocalAgentStore(dataDir), catalog = createCatalog({ ...options, adapters });
  const sessions = new Map(), statuses = new Map(), locks = new Map();
  let disposed = false, generation = 0;
  store.ready.then(() => { for (const record of store.data.conversations) record.state = "disconnected"; }).catch(() => {});
  const preference = agentId => store.data.preferences[agentId] ?? {};
  const recordFor = id => {
    const record = store.data.conversations.find(item => item.id === id);
    demand(record, "unknown-conversation", "本地会话不存在，请重新连接。"); return record;
  };
  const sessionFor = id => {
    recordFor(id); const session = sessions.get(id);
    demand(session, "disconnected", "会话尚未连接，请显式恢复连接。"); return session;
  };
  async function status(agentId) {
    const entry = catalogEntry(agentId), selected = preference(agentId);
    let found, failure;
    try { found = await catalog(agentId, selected.path); } catch (error) { failure = errorResult(error).error; }
    const runtime = store.data.conversations.filter(record => record.agentId === agentId).map(record => record.state);
    const state = runtime.includes("login-required") ? "login-required" : runtime.includes("error") ? "error"
      : runtime.some(value => value === "idle" || value === "running") ? "ready" : statuses.get(agentId);
    const recent = store.data.conversations.filter(record => record.agentId === agentId).flatMap(record => record.events).reverse().find(event => event.type === "error");
    return { id: agentId, agentId, name: entry.name, installed: !!found, enabled: selected.enabled ?? false,
      status: failure ? failure.code === "not-installed" ? "not-installed" : "error" : state ?? (selected.path ? "unverified" : "installed"),
      ...(found?.path || selected.path ? { path: found?.path ?? selected.path } : {}),
      ...(entry.version ? { version: entry.version } : {}), ...(failure ? { error: failure, message: failure.message } : state === "error" || state === "login-required" ? { message: recent?.message ?? "请检查本地代理配置后重新连接。" } : {}) };
  }
  async function detach(agentId) {
    ++generation;
    const results = [];
    for (const [id, session] of sessions) if (!agentId || recordFor(id).agentId === agentId) {
      results.push(await session.disconnect()); sessions.delete(id);
    }
    if (agentId) statuses.delete(agentId); else statuses.clear();
    await store.save(); return { detached: true, treeStopped: results.every(item => item.treeStopped) };
  }
  async function dispatch(input) {
    switch (input.action) {
      case "list": return { agents: await Promise.all(CATALOG.map(entry => status(entry.id))), conversations: store.data.conversations.map(({ id, agentId, projectId, kind, title, updatedAt, state, lastSequence }) => ({ conversationId: id, agentId, projectId, kind, title, updatedAt, state, lastSequence })) };
      case "status": return status(input.agentId);
      case "configure": {
        catalogEntry(input.agentId); demand(typeof input.enabled === "boolean", "invalid-enabled", "enabled 必须是布尔值。");
        if (!input.enabled) await detach(input.agentId);
        store.data.preferences[input.agentId] = { ...preference(input.agentId), enabled: input.enabled };
        await store.save(); return status(input.agentId);
      }
      case "locate": {
        const entry = catalogEntry(input.agentId); await resolveCommand(input.path, entry.args);
        await detach(input.agentId);
        store.data.preferences[input.agentId] = { ...preference(input.agentId), path: input.path };
        await store.save(); return status(input.agentId);
      }
      case "connect": {
        catalogEntry(input.agentId);
        demand(preference(input.agentId).enabled === true, "disabled", "请先在设置中启用此本地代理。");
        demand(typeof input.projectId === "string" && ["scene", "nle", "design", "script"].includes(input.kind), "invalid-project", "连接需要工程 ID、类型和快照。");
        demand(input.newConversation === undefined || typeof input.newConversation === "boolean", "invalid-request", "newConversation 必须是布尔值。");
        demand(!input.newConversation || !input.conversationId, "invalid-request", "新建会话不能同时指定已有会话 ID。");
        let record = input.conversationId ? recordFor(input.conversationId) : input.newConversation === true ? undefined
          : store.data.conversations.find(item => item.agentId === input.agentId && item.projectId === input.projectId && item.kind === input.kind);
        demand(!record || record.agentId === input.agentId && record.projectId === input.projectId && record.kind === input.kind, "conversation-mismatch", "会话与代理或工程不匹配。");
        if (!record) record = createConversation(store, input);
        demand(!sessions.get(record.id)?.connected, "already-connected", "该会话已连接。");
        const stamp = generation;
        const command = await catalog(input.agentId, preference(input.agentId).path);
        demand(stamp === generation && !disposed, "cancelled", "连接已撤销，请重新操作。");
        const session = createLocalAgentSession(record, store, options); sessions.set(record.id, session);
        try { const result = await session.connect(command, input.snapshot, input.context); statuses.set(input.agentId, "ready"); return result; }
        catch (error) { statuses.set(input.agentId, errorResult(error).error.code === "login-required" ? "login-required" : "error"); sessions.delete(record.id); throw error; }
      }
      case "prompt": return sessionFor(input.conversationId).prompt(input);
      case "events": return pollEvents(recordFor(input.conversationId), input.after);
      case "history": return store.history(recordFor(input.conversationId), input.before, input.limit);
      case "answer": return sessionFor(input.conversationId).answer(input);
      case "cancel": { const result = await sessionFor(input.conversationId).cancel(); statuses.delete(recordFor(input.conversationId).agentId); return result; }
      case "disconnect": { const result = await sessionFor(input.conversationId).disconnect(); sessions.delete(input.conversationId); statuses.delete(recordFor(input.conversationId).agentId); return result; }
      case "detach": return detach();
      case "models": return sessionFor(input.conversationId).models();
      case "setConfig": return sessionFor(input.conversationId).setConfig(input);
      default: demand(false, "unknown-action", "不支持此本地代理操作。");
    }
  }
  return {
    async request(input) {
      try {
        await store.ready; demand(!disposed, "disposed", "本地代理服务已关闭。");
        input = boundedJson(input, LIMITS.projectBytes + LIMITS.contextBytes + 65536);
        demand(input && typeof input.action === "string", "invalid-request", "请求缺少 action。");
        // Serialize mutations per agent, but never queue poll/permission/cancel behind a turn.
        const direct = ["events", "history", "answer", "cancel", "disconnect", "detach", "list", "status", "models"].includes(input.action);
        if (direct) return { ok: true, ...await dispatch(input) };
        const key = input.agentId ?? recordFor(input.conversationId).agentId;
        const previous = locks.get(key) ?? Promise.resolve(), stamp = generation;
        const operation = previous.catch(() => {}).then(() => {
          demand(!disposed, "disposed", "本地代理服务已关闭。");
          demand(stamp === generation, "cancelled", "排队操作已撤销，请重新操作。"); return dispatch(input);
        });
        locks.set(key, operation); operation.finally(() => { if (locks.get(key) === operation) locks.delete(key); }).catch(() => {});
        return { ok: true, ...await operation };
      } catch (error) { return errorResult(error); }
    },
    async dispose() {
      if (disposed) return; disposed = true; await store.ready;
      await detach(); await Promise.allSettled(locks.values()); await detach(); await store.flush();
    },
  };
}
