import { appFetch as fetch } from "./app-url";
import { lazy, Suspense, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { LocalAgentSettings } from "./LocalAgentSettings";
import { t } from "./ui/i18n";
import "./ConnectionSettings.css";
const ModelRegistrySettings = lazy(() =>
  import("./ModelRegistrySettings").then((module) => ({ default: module.ModelRegistrySettings })),
);

type Payload = Record<string, unknown>;
type Feedback = { text: string; error?: boolean };
const REQUEST_TIMEOUT_MS = 45_000;
const MODEL_DEFAULTS = { baseUrl: "", apiKey: "", model: "", protocol: "auto", reasoningEffort:"" };
const MEDIA_DEFAULTS = { baseUrl: "", apiKey: "", protocol: "skills" };
const text = (value: unknown, fallback = "") => typeof value === "string" ? value : fallback;

async function settingsRequest(url: string, signal: AbortSignal, body?: unknown): Promise<Payload> {
  const response = await fetch(url, { signal, ...(body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("服务返回无效配置，请重试。");
  const data = payload as Payload;
  if (!response.ok) throw new Error(text(data.error, `请求失败（${response.status}）`));
  return data;
}

/** Each form owns its request lifecycle; switching tabs never clears a draft. */
function useSettingsRequest() {
  const [busy, setBusy] = useState(""), [feedback, setFeedback] = useState<Feedback | null>(null);
  const controller = useRef<AbortController | null>(null), mounted = useRef(false);
  const retry = useRef<(() => void) | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; controller.current?.abort(); controller.current = null; }; }, []);
  const run = async (action: string, work: (signal: AbortSignal) => Promise<string>) => {
    if (controller.current) return;
    const current = new AbortController(); controller.current = current;
    const timeout = setTimeout(() => current.abort(new DOMException("请求超时", "TimeoutError")), REQUEST_TIMEOUT_MS);
    setBusy(action); setFeedback(null); retry.current = null;
    try {
      const result = await work(current.signal);
      if (mounted.current && controller.current === current && !current.signal.aborted) setFeedback({ text: result });
    } catch (error) {
      if (!mounted.current || controller.current !== current) return;
      setFeedback({ error: true, text: current.signal.aborted ? "请求超时，请检查服务后重试。" : `操作失败：${error instanceof Error ? error.message : "服务暂未响应"}` });
      retry.current = () => void run(action, work);
    } finally {
      clearTimeout(timeout);
      if (controller.current === current) { controller.current = null; if (mounted.current) setBusy(""); }
    }
  };
  return { busy, feedback, run, retry: () => retry.current?.() };
}

function RequestFeedback({ request }: { request: ReturnType<typeof useSettingsRequest> }) {
  if (request.busy) return <p role="status" className="connection-feedback">{request.busy}…</p>;
  if (!request.feedback) return null;
  return <div className={request.feedback.error ? "connection-error" : "connection-feedback"}>
    <p role={request.feedback.error ? "alert" : "status"}>{request.feedback.text}</p>
    {request.feedback.error && <button type="button" className="g-btn g-btn--sm" onClick={request.retry}>重试</button>}
  </div>;
}

/** One group: a status-first row, then a folded disclosure holding every parameter. */
function ApiModelSettings() {
  const [draft, setDraft] = useState(MODEL_DEFAULTS), [models, setModels] = useState<string[]>([]);
  const [configured, setConfigured] = useState(false), [keyHint, setKeyHint] = useState("");
  const request = useSettingsRequest(), datalistId = useId(), draftRef = useRef(draft);
  draftRef.current = draft;
  const load = () => request.run("读取模型配置", async signal => {
    const data = await settingsRequest("/api/settings/llm", signal);
    if (signal.aborted) return "";
    setDraft({ baseUrl: text(data.baseUrl), model: text(data.model), protocol: text(data.protocol, "auto"), reasoningEffort:text(data.reasoningEffort), apiKey: "" });
    setConfigured(data.configured === true); setKeyHint(text(data.keyHint));
    return "模型配置已读取。";
  });
  useEffect(() => { void load(); }, []);
  const run = (action: "models" | "save" | "test") => request.run(action === "save" ? "保存配置" : action === "models" ? "获取模型列表" : "测试连接", async signal => {
    const data = await settingsRequest(`/api/settings/llm${action === "save" ? "" : `/${action}`}`, signal, draftRef.current);
    if (signal.aborted) return "";
    if (action === "models") {
      if (!Array.isArray(data.models) || data.models.some(item => !item || typeof item.id !== "string")) throw new Error("模型列表无效，请重试。");
      setModels([...new Set(data.models.map(item => String(item.id)))]);
      setDraft(current => ({ ...current, baseUrl: text(data.baseUrl, current.baseUrl) }));
      return data.models.length ? `获取 ${data.models.length} 个模型。选择后保存，再测试协议。` : "服务未返回模型；可手动填写模型名称后保存。";
    }
    if (action === "save") {
      setDraft(current => ({ ...current, apiKey: "" })); setConfigured(true); setKeyHint("");
      window.dispatchEvent(new Event("glint:model-settings"));
      return data.storage === "saved" ? "已保存到本机数据目录；密钥不写入浏览器存储，重启后自动恢复。" : "已保存到当前服务进程。密钥不写入浏览器存储，重启后需重新配置。";
    }
    return `连接通过 · ${text(data.protocol, "已保存协议")} · ${typeof data.elapsedMs === "number" ? `${data.elapsedMs} ms` : "测试完成"}`;
  });
  const ready = Boolean(draft.baseUrl.trim() && draft.model.trim());
  return <div className="connection-form-panel">
    <form className="connection-group" onSubmit={event => { event.preventDefault(); if (ready) void run("save"); }}>
      <div className="connection-row">
        <div className="connection-row-main">
          <h3 className="connection-row-name">API 模型</h3>
          <p className="connection-row-status"><span className={configured ? "g-dot" : "g-dot g-dot--off"} aria-hidden="true" />{configured ? `已配置${keyHint ? ` · ${keyHint}` : ""}` : "未配置"}</p>
        </div>
        <button type="submit" className="g-btn g-btn--primary" disabled={Boolean(request.busy) || !ready} title={request.busy ? "请等待当前操作完成" : !ready ? "先填写服务地址与模型名称" : "保存模型配置"}>{request.busy === "保存配置" ? "保存中…" : "保存配置"}</button>
      </div>
      <details className="connection-details">
        <summary><span>连接参数</span><span className="connection-details-meta">地址 · 密钥 · 协议</span></summary>
        <div className="connection-details-body">
          <fieldset disabled={Boolean(request.busy)} className="connection-fields">
            <legend className="g-sr">模型连接配置</legend>
            <label className="connection-wide g-form-row"><span>服务地址</span><input className="g-field" aria-label="模型服务地址" placeholder="https://api.example.com/v1" value={draft.baseUrl} onChange={event => { setDraft({ ...draft, baseUrl: event.target.value, apiKey: "" }); setModels([]); setConfigured(false); setKeyHint(""); }} /></label>
            <label className="connection-wide g-form-row"><span>API 密钥</span><input className="g-field" aria-label="模型 API 密钥" type="password" autoComplete="off" value={draft.apiKey} onChange={event => setDraft({ ...draft, apiKey: event.target.value })} placeholder="已配置时可留空；更换地址需要新密钥" /></label>
            <label className="g-form-row"><span>模型名称</span><input className="g-field" aria-label="模型名称" list={datalistId} value={draft.model} onChange={event => setDraft({ ...draft, model: event.target.value })} /><datalist id={datalistId}>{models.map(id => <option key={id} value={id} />)}</datalist></label>
            <label className="g-form-row"><span>协议</span><select className="g-field" aria-label="模型协议" value={draft.protocol} onChange={event => setDraft({ ...draft, protocol: event.target.value })}><option value="auto">自动适配</option><option value="openai">OpenAI Chat Completions</option><option value="responses">OpenAI Responses</option><option value="anthropic">Anthropic Messages</option><option value="gemini">Gemini</option></select></label>
            <label className="g-form-row"><span>推理强度</span><select className="g-field" aria-label="模型推理强度" value={draft.reasoningEffort} onChange={event=>setDraft({...draft,reasoningEffort:event.target.value})}><option value="">服务默认</option><option value="low">低 · 更快生成</option><option value="high">高</option><option value="max">最高</option></select><small>仅发送到支持 reasoning_effort 的 Chat Completions 服务；生成超时可先选低档。</small></label>
          </fieldset>
          <div className="connection-actions">
            <button type="button" className="g-btn g-btn--sm g-btn--quiet" disabled={Boolean(request.busy) || !draft.baseUrl.trim()} title={!draft.baseUrl.trim() ? "先填写服务地址" : "读取服务的模型目录"} onClick={() => void run("models")}>{request.busy === "获取模型列表" ? "获取中…" : "获取模型列表"}</button>
            <button type="button" className="g-btn g-btn--sm g-btn--quiet" disabled={Boolean(request.busy)} title="会发起一次真实模型调用" onClick={() => void run("test")}>{request.busy === "测试连接" ? "测试中…" : "测试已保存配置（一次模型调用）"}</button>
          </div>
          <p className="connection-note">自动适配只在端点明确不兼容时换协议；鉴权、额度、限流与超时不重试。</p>
        </div>
      </details>
    </form>
    <RequestFeedback request={request} />
  </div>;
}

function MediaSettings() {
  const [draft, setDraft] = useState(MEDIA_DEFAULTS), [hint, setHint] = useState("未配置");
  const request = useSettingsRequest(), draftRef = useRef(draft);
  draftRef.current = draft;
  const configured = hint.startsWith("已配置");
  const load = () => request.run("读取媒体配置", async signal => {
    const data = await settingsRequest("/api/settings/media", signal);
    if (signal.aborted) return "";
    setDraft({ baseUrl: text(data.baseUrl), protocol: text(data.protocol, "skills"), apiKey: "" });
    setHint(data.configured ? `已配置 ${text(data.keyHint)}` : "未配置");
    return "媒体配置已读取。";
  });
  useEffect(() => { void load(); }, []);
  const save = () => request.run("保存媒体网关", async signal => {
    const current = draftRef.current;
    const data = await settingsRequest("/api/settings/media", signal, { ...current, apiKey: current.apiKey || undefined });
    if (signal.aborted) return "";
    setHint(`已配置 ${text(data.keyHint)}`); setDraft(current => ({ ...current, apiKey: "" }));
    return "媒体网关已保存；生成接口会立即使用新配置。";
  });
  return <div className="connection-form-panel">
    <form className="connection-group" onSubmit={event => { event.preventDefault(); if (draft.baseUrl.trim()) void save(); }}>
      <div className="connection-row">
        <div className="connection-row-main">
          <h3 className="connection-row-name">媒体服务</h3>
          <p className="connection-row-status"><span className={configured ? "g-dot" : "g-dot g-dot--off"} aria-hidden="true" />{hint}</p>
        </div>
        <button type="submit" className="g-btn g-btn--primary" disabled={Boolean(request.busy) || !draft.baseUrl.trim()} title={request.busy ? "请等待当前操作完成" : !draft.baseUrl.trim() ? "先填写媒体网关地址" : "保存媒体配置"}>{request.busy === "保存媒体网关" ? "保存中…" : "保存媒体网关"}</button>
      </div>
      <details className="connection-details">
        <summary><span>网关参数</span><span className="connection-details-meta">图片 · 视频 · 音频</span></summary>
        <div className="connection-details-body">
          <fieldset disabled={Boolean(request.busy)} className="connection-fields">
            <legend className="g-sr">媒体服务配置</legend>
            <label className="connection-wide g-form-row"><span>媒体网关地址</span><input className="g-field" aria-label="媒体网关地址" placeholder="https://api.example.com" value={draft.baseUrl} onChange={event => { setDraft({ ...draft, baseUrl: event.target.value, apiKey: "" }); setHint("未配置"); }} /></label>
            <label className="connection-wide g-form-row"><span>媒体网关密钥</span><input className="g-field" aria-label="媒体网关密钥" type="password" autoComplete="off" value={draft.apiKey} onChange={event => setDraft({ ...draft, apiKey: event.target.value })} placeholder="已配置时可留空；更换地址需要新密钥" /></label>
            <label className="connection-wide g-form-row"><span>网关协议</span><select className="g-field" aria-label="网关协议" value={draft.protocol} onChange={event => setDraft({ ...draft, protocol: event.target.value })}><option value="skills">skills（模型目录/异步任务）</option><option value="openai-images">OpenAI Images（同步出图）</option></select></label>
          </fieldset>
          <p className="connection-note">与文本模型分开配置；接口只返回密钥末四位，密钥由服务端保存。</p>
        </div>
      </details>
    </form>
    <RequestFeedback request={request} />
  </div>;
}

const TABS = [
  { id: "local", label: "本地智能体" },
  { id: "api", label: "API 模型" },
  { id: "media", label: "媒体服务" },
  { id: "registry", label: t("registry.title") },
] as const;
type Tab = (typeof TABS)[number]["id"];
export function ModelSettings() {
  const [tab, setTab] = useState<Tab>("local");
  const [registryMounted, setRegistryMounted] = useState(false);
  useEffect(() => {
    if (tab === "registry") setRegistryMounted(true);
  }, [tab]);
  const id = useId(),
    tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const navigate = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = event.key === "ArrowRight" ? (index + 1) % TABS.length : event.key === "ArrowLeft" ? (index + TABS.length - 1) % TABS.length : event.key === "Home" ? 0 : event.key === "End" ? TABS.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault(); setTab(TABS[next]!.id); tabs.current[next]?.focus();
  };
  return (
    <section className="connection-settings tool-span" aria-label="模型连接设置">
      <header className="connection-heading">
        <span className="g-label">设置 · 连接</span>
        <h2 className="g-title">模型连接</h2>
        <p className="g-sub">本地智能体、远程模型与媒体服务各自独立；密钥只留在服务端。</p>
      </header>
      <div role="tablist" aria-label="连接类型" className="connection-tabs">
        {TABS.map((item, index) => (
          <button
            key={item.id}
            ref={(element) => {
              tabs.current[index] = element;
            }}
            id={`${id}-tab-${item.id}`}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            aria-controls={`${id}-panel-${item.id}`}
            tabIndex={tab === item.id ? 0 : -1}
            onClick={() => setTab(item.id)}
            onKeyDown={(event) => navigate(event, index)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div
        id={`${id}-panel-local`}
        role="tabpanel"
        aria-labelledby={`${id}-tab-local`}
        hidden={tab !== "local"}
        tabIndex={0}
      >
        <LocalAgentSettings />
      </div>
      <div
        id={`${id}-panel-api`}
        role="tabpanel"
        aria-labelledby={`${id}-tab-api`}
        hidden={tab !== "api"}
        tabIndex={0}
      >
        <ApiModelSettings />
      </div>
      <div
        id={`${id}-panel-media`}
        role="tabpanel"
        aria-labelledby={`${id}-tab-media`}
        hidden={tab !== "media"}
        tabIndex={0}
      >
        <MediaSettings />
      </div>
      <div
        id={`${id}-panel-registry`}
        role="tabpanel"
        aria-labelledby={`${id}-tab-registry`}
        hidden={tab !== "registry"}
        tabIndex={0}
      >
        {registryMounted && (
          <Suspense fallback={<p role="status">{t("container.loading")}</p>}>
            <ModelRegistrySettings />
          </Suspense>
        )}
      </div>
    </section>
  );
}
