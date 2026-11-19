import path from "node:path";
import { randomUUID } from "node:crypto";
import { open, lstat } from "node:fs/promises";
import { boundedJson, demand, ensureDirectory, atomicJson, readBounded, LIMITS, redact, LocalAgentError } from "./local-agent-common.mjs";

const journals = new WeakMap();
const HISTORY = Object.freeze({ blockBytes: 65536, pageSize: 50, maxPageSize: 100, pageBytes: LIMITS.logBytes });
function historyEvent(input) {
  if (input.type === "update" && /thought|reasoning/i.test(input.update?.sessionUpdate ?? "")) return null;
  const { sequence, at, type, turnId } = input;
  const event = { sequence, at, type, ...(turnId ? { turnId } : {}) };
  if (type === "update") {
    const update = input.update ?? {};
    event.update = { sessionUpdate: update.sessionUpdate };
    if (["agent_message_chunk", "user_message_chunk"].includes(update.sessionUpdate) && update.content?.type === "text") event.update.content = { type: "text", text: update.content.text };
    for (const key of ["toolCallId", "title", "kind", "status"]) if (typeof update[key] === "string") event.update[key] = update[key];
  } else {
    for (const key of ["text", "state", "stopReason", "requestId", "requestType", "message", "code", "baseDigest", "treeStopped", "resumed"]) if (["string", "boolean"].includes(typeof input[key])) event[key] = input[key];
    if (type === "proposal") { event.projectId = input.project?.id ?? input.projectId; event.title = input.project?.title ?? input.title; }
  }
  return redact(event);
}
function persistedEvent(input) {
  return input.type === "update" ? historyEvent(input) : redact(input);
}
async function openJournal(file) {
  let handle;
  try { handle = await open(file, "ax+", 0o600); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    const stat = await lstat(file);
    demand(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, "unsafe-history", "聊天历史文件不能是链接。");
    handle = await open(file, "r+");
    const current = await handle.stat();
    if (current.ino !== stat.ino || current.nlink !== 1) { await handle.close(); throw new LocalAgentError("unsafe-history", "聊天历史文件已变化。"); }
  }
  return handle;
}
async function writeRow(handle, event, position) {
  const buffer = Buffer.from(JSON.stringify(event) + "\n");
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, position + offset);
    demand(bytesWritten > 0, "history-write", "聊天历史未能完整写入，请检查磁盘空间。"); offset += bytesWritten;
  }
  return buffer.length;
}
async function pageFrom(handle, end, limit) {
  let position = end, pending = Buffer.alloc(0), nextBefore = end, bytes = 0;
  const events = [];
  if (end) { const marker = Buffer.alloc(1); await handle.read(marker, 0, 1, end - 1); demand(marker[0] === 10, "invalid-cursor", "历史游标不在消息边界。"); }
  while (position || pending.length) {
    let boundary = pending.lastIndexOf(10, pending.length - 2);
    if (position && (pending.length < 2 || boundary < 0)) {
      const length = Math.min(HISTORY.blockBytes, position), chunk = Buffer.alloc(length);
      position -= length; await handle.read(chunk, 0, length, position); pending = Buffer.concat([chunk, pending]);
      demand(pending.length <= LIMITS.eventBytes + HISTORY.blockBytes, "invalid-history", "单条聊天历史超过限制。");
      continue;
    }
    const row = pending.subarray(boundary + 1, pending.length - 1);
    if (events.length && bytes + row.length > HISTORY.pageBytes) break;
    let event;
    try { event = JSON.parse(row.toString("utf8")); } catch { throw new LocalAgentError("invalid-history", "聊天历史文件损坏，请保留文件并修复后重试。"); }
    events.unshift(event); bytes += row.length; nextBefore = position + boundary + 1;
    pending = pending.subarray(0, boundary + 1);
    if (events.length >= limit) break;
  }
  return { events, nextBefore: nextBefore > 0 ? String(nextBefore) : null, hasMore: nextBefore > 0 };
}
function createJournal(file, record) {
  let tail, lastSequence = 0, failure;
  const previousEvents = record.events.slice(), previousSequence = record.lastSequence;
  const ready = (async () => {
    const handle = await openJournal(file);
    try {
      let { size } = await handle.stat();
      if (size) {
        const length = Math.min(size, LIMITS.eventBytes + 1), buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, size - length);
        const newline = buffer.lastIndexOf(10);
        demand(newline >= 0, "invalid-history", "聊天历史尾部损坏，请备份后修复。");
        if (newline !== buffer.length - 1) { size -= buffer.length - newline - 1; await handle.truncate(size); record.historyIncomplete = true; }
        lastSequence = (await pageFrom(handle, size, 1)).events[0]?.sequence ?? 0;
      }
      if (!size && previousSequence) record.historyIncomplete ||= (previousEvents[0]?.sequence ?? previousSequence + 1) > 1;
      for (const input of previousEvents) {
        const event = historyEvent(input);
        if (event && event.sequence > lastSequence) { size += await writeRow(handle, event, size); lastSequence = event.sequence; }
      }
      record.lastSequence = Math.max(record.lastSequence, lastSequence);
    } finally { await handle.close(); }
  })();
  tail = ready;
  const queue = work => {
    tail = tail.then(work).catch(error => { failure = new LocalAgentError("history-write", "聊天历史写入失败，请检查数据目录空间和权限后重启。"); throw failure; });
    void tail.catch(() => {}); return tail;
  };
  return {
    ready,
    append(event) { return queue(async () => {
      if (event.sequence <= lastSequence) return;
      const handle = await openJournal(file);
      try { const { size } = await handle.stat(); await writeRow(handle, event, size); lastSequence = event.sequence; }
      finally { await handle.close(); }
    }); },
    async flush() { await tail; if (failure) throw failure; },
    async history(before, limit) {
      await tail;
      const handle = await openJournal(file);
      try {
        const { size } = await handle.stat();
        demand(before === undefined || typeof before === "string" && /^(0|[1-9]\d*)$/.test(before), "invalid-cursor", "历史游标无效，请使用上一页返回的 nextBefore。");
        const end = before === undefined ? size : Number(before);
        demand(Number.isSafeInteger(end) && end >= 0 && end <= size, "invalid-cursor", "历史游标超出范围。");
        return { ...await pageFrom(handle, end, limit), incomplete: !!record.historyIncomplete, state: record.state };
      } finally { await handle.close(); }
    },
  };
}
export function createLocalAgentStore(dataDir) {
  demand(typeof dataDir === "string" && path.isAbsolute(dataDir), "invalid-data-dir", "dataDir 必须是绝对路径。");
  const root = path.join(dataDir, "local-agent-state"), workspaces = path.join(dataDir, "agent-workspaces");
  const file = path.join(root, "conversations.json"), historyDir = path.join(root, "history");
  let tail = Promise.resolve(), dirty = false, writing = false;
  const data = { version: 1, preferences: {}, conversations: [] };
  function bind(record) {
    record.title ||= record.events.find(event => event.type === "turn-started")?.text?.slice(0, 80) || record.projectId;
    record.hasPromptTitle ??= record.events.some(event => event.type === "turn-started");
    record.updatedAt ||= record.events.at(-1)?.at ?? Date.now();
    const journal = createJournal(path.join(historyDir, `${record.id}.jsonl`), record);
    journals.set(record, journal); return journal.ready;
  }
  function save() {
    dirty = true;
    if (writing) return tail;
    writing = true;
    tail = Promise.resolve().then(async () => {
      while (dirty) {
        dirty = false;
        await Promise.all(data.conversations.map(record => journals.get(record).flush()));
        let total = data.conversations.reduce((sum, record) => sum + Buffer.byteLength(JSON.stringify(record.events)), 0);
        while (total > 24 * 1024 * 1024) {
          const oldest = data.conversations.filter(record => record.events.length).sort((a, b) => a.events[0].at - b.events[0].at)[0];
          total -= Buffer.byteLength(JSON.stringify(oldest.events.shift()));
        }
        const snapshot = boundedJson(redact({ ...data, conversations: data.conversations.map(record => ({ ...record, events: record.events.map(persistedEvent).filter(Boolean) })) }), 32 * 1024 * 1024);
        await atomicJson(file, snapshot);
      }
    }).finally(() => { writing = false; });
    return tail;
  }
  const ready = (async () => {
    await ensureDirectory(dataDir); await ensureDirectory(root); await ensureDirectory(workspaces); await ensureDirectory(historyDir);
    try {
      const saved = await readBounded(file, 32 * 1024 * 1024);
      demand(saved.version === 1 && Array.isArray(saved.conversations) && saved.conversations.length <= LIMITS.conversations, "invalid-store", "本地会话索引损坏，请备份后重试。");
      demand(saved.preferences && typeof saved.preferences === "object" && !Array.isArray(saved.preferences), "invalid-store", "本地代理设置损坏。");
      data.preferences = saved.preferences;
      demand(saved.conversations.every(record => /^[a-f0-9-]{36}$/.test(record.id) && ["scene", "nle", "design", "script"].includes(record.kind)
        && Array.isArray(record.events) && record.events.length <= LIMITS.events && Number.isSafeInteger(record.lastSequence)
        && record.choices && typeof record.choices === "object" && (!record.sessionId || typeof record.sessionId === "string")), "invalid-store", "本地会话记录损坏。");
      data.conversations = saved.conversations;
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    for (const record of data.conversations) { record.events = record.events.map(persistedEvent).filter(Boolean); await bind(record); }
  })();
  return {
    data, ready, workspace: id => path.join(workspaces, id), bind, save,
    async history(record, before, limit = HISTORY.pageSize) {
      demand(Number.isSafeInteger(limit) && limit > 0 && limit <= HISTORY.maxPageSize, "invalid-limit", "历史分页条数必须为 1 到 100。");
      return journals.get(record).history(before, limit);
    },
    async flush() { await tail; await Promise.all(data.conversations.map(record => journals.get(record).flush())); },
  };
}
export function createConversation(store, { agentId, projectId, kind, snapshot }) {
  demand(store.data.conversations.length < LIMITS.conversations, "conversation-limit", "本地会话达到 64 个上限，请先保留历史并使用已有会话。");
  const record = { id: randomUUID(), agentId, projectId, kind, title: typeof snapshot?.title === "string" ? redact(snapshot.title).slice(0, 80) : projectId,
    updatedAt: Date.now(), sessionId: null, choices: {}, events: [], lastSequence: 0, state: "disconnected" };
  store.data.conversations.push(record); void store.bind(record).catch(() => { record.state = "error"; }); return record;
}
export function appendEvent(record, input) {
  if (input.type === "update" && /thought|reasoning/i.test(input.update?.sessionUpdate ?? "")) return null;
  const event = boundedJson(redact({ ...input, sequence: ++record.lastSequence, at: Date.now() }), LIMITS.eventBytes);
  const archived = historyEvent(event), journal = journals.get(record);
  if (archived && journal) void journal.append(archived).catch(() => { record.state = "error"; });
  if (input.type === "turn-started" && !record.hasPromptTitle) { record.title = event.text.slice(0, 80); record.hasPromptTitle = true; }
  record.updatedAt = event.at; record.events.push(event);
  let bytes = record.events.reduce((total, item) => total + Buffer.byteLength(JSON.stringify(item)), 0);
  while (record.events.length > LIMITS.events || bytes > LIMITS.logBytes) bytes -= Buffer.byteLength(JSON.stringify(record.events.shift()));
  return event;
}
export function pollEvents(record, after = 0) {
  demand(Number.isSafeInteger(after) && after >= 0 && after <= record.lastSequence, "invalid-cursor", "事件游标无效，请重新读取会话。");
  return { events: record.events.filter(event => event.sequence > after), lastSequence: record.lastSequence, state: record.state,
    truncated: after < (record.events[0]?.sequence ?? 1) - 1 };
}
