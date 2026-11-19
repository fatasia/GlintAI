import { applicationUrl } from "./app-url";
import { useEffect, useId, useRef, useState } from "react";
import { field } from "./ui-tokens";
import { isLocalAgentAvailable, localAgentRequest, readLocalAgentList, readLocalAgentUpdate, type LocalAgent, type LocalAgentSettingsRequest } from "./local-agent-client";
import "./ConnectionSettings.css";

const INSTALL_LINKS: Record<string, string> = {
  claude: "https://code.claude.com/docs/en/setup",
  "claude-code": "https://code.claude.com/docs/en/setup",
  codex: "https://developers.openai.com/codex/cli/",
  gemini: "https://geminicli.com/docs/get-started/installation/",
  "gemini-cli": "https://geminicli.com/docs/get-started/installation/",
  opencode: "https://opencode.ai/docs/",
};
const STATUS_LABELS: Record<string, string> = {
  connected: "已连接", ready: "就绪", available: "可用", installed: "已安装", authenticated: "已授权",
  disconnected: "未连接", idle: "待机", disabled: "已停用", running: "运行中", busy: "忙碌中",
  error: "检测异常", failed: "检测异常", unavailable: "不可用", "not-installed": "未安装",
  "not_installed": "未安装", missing: "未安装", "not-authenticated": "未授权", "needs-auth": "待授权",
};
function statusLabel(agent: LocalAgent) {
  if (!agent.installed) return "未安装";
  if (agent.enabled === false) return "已停用";
  return STATUS_LABELS[agent.status] ?? "待检测";
}
const errorText = (error: unknown) => error instanceof Error ? error.message : "桌面版暂未响应";

type AgentAction = Exclude<LocalAgentSettingsRequest, { action: "list" }>;
type AgentCardProps = { agent: LocalAgent; index: number; onStart(id: string): void; onFinish(id: string): void; onUpdate(agent: LocalAgent): void };
function AgentCard({ agent, index, onStart, onFinish, onUpdate }: AgentCardProps) {
  const [busy, setBusy] = useState<AgentAction | null>(null), [error, setError] = useState("");
  const [notice, setNotice] = useState(""), [retry, setRetry] = useState<AgentAction | null>(null);
  const [path, setPath] = useState(agent.path ?? "");
  const pending = useRef(false), mounted = useRef(false), details = useRef<HTMLDetailsElement>(null);
  const pathId = useId();
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setPath(agent.path ?? ""); }, [agent.path]);
  const run = async (request: AgentAction) => {
    if (pending.current) return;
    pending.current = true; onStart(agent.id); setBusy(request); setError(""); setNotice(""); setRetry(null);
    try {
      const result = await localAgentRequest<unknown>(request);
      if (!mounted.current) return;
      let updated = readLocalAgentUpdate(result, agent.id);
      if (!updated && request.action !== "status") updated = readLocalAgentUpdate(await localAgentRequest({ action: "status", agentId: agent.id }), agent.id);
      if (!updated) throw new Error("未收到该智能体的检测状态");
      if (!mounted.current) return;
      onUpdate(updated);
      if (request.action === "configure" && updated.enabled !== request.enabled) throw new Error("启用状态尚未生效，请检测状态后重试");
      setNotice(request.action === "locate" ? "路径已更新，检测完成。" : request.action === "configure"
        ? request.enabled ? "已启用；在工程会话中连接。" : "已停用；未退出本机账号。" : "检测完成，状态已更新。");
    } catch (cause) {
      if (mounted.current) { setError(`操作失败：${errorText(cause)}`); setRetry(request); }
    } finally { pending.current = false; onFinish(agent.id); if (mounted.current) setBusy(null); }
  };
  const configuring = busy?.action === "configure", installLink = INSTALL_LINKS[agent.id];
  return <li className="local-agent-row" aria-label={agent.name} aria-busy={Boolean(busy)}>
    <span className="local-agent-index" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
    <div className="local-agent-content">
      <div className="local-agent-heading"><h4>{agent.name}</h4><span className="local-agent-status"><span aria-hidden="true">{!agent.installed ? "−" : ["error", "failed", "unavailable"].includes(agent.status) ? "!" : "·"}</span>{statusLabel(agent)}</span></div>
      <p className="connection-note">{agent.message || (agent.installed ? "沿用本机登录状态；启用后可在工程中使用。" : "安装完成后，刷新检测即可。")}</p>
      <details ref={details} className="connection-details" onKeyDown={event => {
        if (event.key === "Escape" && details.current?.open) { event.preventDefault(); event.stopPropagation(); details.current.open = false; details.current.querySelector("summary")?.focus(); }
      }}>
        <summary>版本与路径</summary>
        <dl className="local-agent-meta"><div><dt>版本</dt><dd>{agent.version || "未检测到"}</dd></div><div><dt>路径</dt><dd><code>{agent.path || "未定位"}</code></dd></div></dl>
        <form className="local-agent-locate" onSubmit={event => { event.preventDefault(); if (path.trim()) void run({ action: "locate", agentId: agent.id, path: path.trim() }); }}>
          <label htmlFor={pathId}>可执行文件路径<input id={pathId} aria-label={`${agent.name} 可执行文件路径`} style={field} value={path} disabled={Boolean(busy)} onChange={event => setPath(event.target.value)} placeholder="输入完整路径" autoComplete="off" spellCheck={false} /></label>
          <button type="submit" className="connection-button" disabled={Boolean(busy) || !path.trim()} title={busy ? "请等待当前操作完成" : !path.trim() ? "先输入可执行文件路径" : "使用此路径重新检测"}>{busy?.action === "locate" ? "定位中…" : "定位路径"}</button>
        </form>
      </details>
      {(busy || notice) && <p role="status" className="connection-feedback">{busy ? busy.action === "status" ? "正在检测本机状态…" : busy.action === "locate" ? "正在定位并检测…" : busy.enabled ? "正在启用…" : "正在停用…" : notice}</p>}
      {error && <div className="connection-error"><p role="alert">{error}</p><button type="button" className="connection-button" onClick={() => retry && void run(retry)}>重试</button></div>}
    </div>
    <div className="local-agent-actions">
      {agent.installed ? <button type="button" className="connection-button" disabled={Boolean(busy)} title={busy ? "请等待当前操作完成" : "只更改 Glint 启用状态，不退出账号"} onClick={() => void run({ action: "configure", agentId: agent.id, enabled: agent.enabled !== true })}>{configuring ? busy.enabled ? "启用中…" : "停用中…" : agent.enabled ? "停用" : "启用"}</button>
        : installLink ? <a className="connection-button" href={applicationUrl(installLink)} target="_blank" rel="noreferrer">官方安装 <span aria-hidden="true">↗</span></a> : <span className="connection-note">请从该智能体官网安装</span>}
      <button type="button" className="connection-button connection-button--quiet" disabled={Boolean(busy)} title={busy ? "请等待当前操作完成" : "读取本机真实状态"} onClick={() => void run({ action: "status", agentId: agent.id })}>{busy?.action === "status" ? "检测中…" : "检测状态"}</button>
    </div>
  </li>;
}

export function LocalAgentSettings() {
  const available = isLocalAgentAvailable();
  const [agents, setAgents] = useState<LocalAgent[]>([]), [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const generation = useRef(0), revisions = useRef(new Map<string, number>()), activeAgents = useRef(new Set<string>()), listPending = useRef(false);
  const markChanged = (id: string) => revisions.current.set(id, (revisions.current.get(id) ?? 0) + 1);
  const refresh = async () => {
    if (!available || listPending.current) return;
    const current = generation.current, snapshot = new Map(revisions.current);
    listPending.current = true; setLoading(true); setError(""); setNotice("");
    try {
      const next = readLocalAgentList(await localAgentRequest({ action: "list" }));
      if (current !== generation.current) return;
      // A slow list response must not undo a newer per-agent operation.
      setAgents(previous => {
        const changed = (id: string) => activeAgents.current.has(id) || snapshot.get(id) !== revisions.current.get(id);
        return [...next.map(agent => changed(agent.id) ? previous.find(item => item.id === agent.id) ?? agent : agent),
          ...previous.filter(agent => changed(agent.id) && !next.some(item => item.id === agent.id))];
      });
      setLoaded(true); setNotice(`检测完成 · ${next.length} 个本地智能体`);
    } catch (cause) { if (current === generation.current) setError(`检测失败：${errorText(cause)}`); }
    finally { if (current === generation.current) { listPending.current = false; setLoading(false); } }
  };
  useEffect(() => {
    void refresh();
    return () => { generation.current++; listPending.current = false; };
    // Availability is checked on each mount; there is no browser fallback transport.
  }, [available]);
  if (!available) return <div className="connection-empty" role="status">
    <span className="connection-eyebrow">本机运行</span><h3>在桌面版使用本地智能体</h3>
    <p>浏览器不访问本机智能体。请打开 Glint 桌面版进行检测与启用。</p>
    <p className="connection-note">API 模型和媒体服务仍可正常配置与使用。</p>
  </div>;
  return <div className="local-agent-settings">
    <div className="connection-panel-heading"><div><h3>本地智能体</h3><p className="connection-note">检测本机安装与登录状态，不代为安装，也不退出账号。</p></div>
      <button type="button" className="connection-button connection-button--primary" disabled={loading} title={loading ? "正在检测，请稍候" : "重新检测本机智能体"} onClick={() => void refresh()}>{loading ? "检测中…" : "刷新检测"}</button></div>
    {(loading || notice) && <p role="status" className="connection-feedback">{loading ? "正在检测本机智能体…" : notice}</p>}
    {error && <div className="connection-error"><p role="alert">{error}</p><button type="button" className="connection-button" onClick={() => void refresh()}>重试检测</button></div>}
    {!loaded && loading && <div className="local-agent-skeleton" aria-hidden="true"><span /><span /><span /></div>}
    {loaded && !agents.length && <div className="connection-empty"><h4>尚未发现可用的智能体</h4><p>安装 Claude Code 或 Codex 后刷新检测；已有安装可检查桌面版的检测路径。</p><div className="connection-actions"><a className="connection-button" href={applicationUrl(INSTALL_LINKS.claude)} target="_blank" rel="noreferrer">Claude Code 官方安装</a><a className="connection-button" href={applicationUrl(INSTALL_LINKS.codex)} target="_blank" rel="noreferrer">Codex 官方安装</a></div></div>}
    {!!agents.length && <ol className="local-agent-list">{agents.map((agent, index) => <AgentCard key={agent.id} agent={agent} index={index} onStart={id => { activeAgents.current.add(id); markChanged(id); }} onFinish={id => { activeAgents.current.delete(id); }} onUpdate={updated => { markChanged(updated.id); setAgents(current => current.map(item => item.id === updated.id ? updated : item)); }} />)}</ol>}
    <p className="connection-note local-agent-footnote">此处只管理启用状态与本机检测。实际连接、对话与断开在工程会话中进行。</p>
  </div>;
}
