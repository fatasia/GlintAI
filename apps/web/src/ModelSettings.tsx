import { useState } from "react";
const field = { width: "100%", minWidth: 0, border: "1px solid #35414e", borderRadius: 8, background: "#141b24", color: "#f2f6fa", padding: 10, font: "inherit" };
export function ModelSettings() {
  const [open, setOpen] = useState(false), [baseUrl, setBaseUrl] = useState(""), [apiKey, setApiKey] = useState(""), [model, setModel] = useState(""), [protocol, setProtocol] = useState("auto");
  const [models, setModels] = useState<{ id: string }[]>([]), [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const run = async (action: "models" | "save" | "test") => {
    setBusy(true); setMessage("");
    try {
      const response = await fetch(`/api/settings/llm${action === "save" ? "" : `/${action}`}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseUrl, apiKey, model, protocol }), signal: AbortSignal.timeout(45000) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error);
      if (action === "models") { setModels(data.models); setBaseUrl(data.baseUrl); setMessage(`获取 ${data.models.length} 个模型。选择后保存，再测试协议。`); }
      if (action === "save") { setApiKey(""); setMessage("已保存到当前服务进程。密钥不会写入浏览器存储，重启后需重新配置。"); }
      if (action === "test") setMessage(`连接通过 · ${data.protocol} · ${data.elapsedMs} ms`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "配置失败"); }
    finally { setBusy(false); }
  };
  return <section style={{ padding: 22 }}>
    <button type="button" onClick={async () => {
      setOpen(!open);
      if (!open) try { const data = await (await fetch("/api/settings/llm")).json(); setBaseUrl(data.baseUrl); setModel(data.model); setProtocol(data.protocol); } catch { setMessage("配置读取失败"); }
    }}>模型连接设置</button>
    {open && <div style={{ display: "grid", gap: 12, marginTop: 14 }}>
      <label>服务地址<input aria-label="模型服务地址" placeholder="https://api.example.com/v1" style={field} value={baseUrl} onChange={event => { setBaseUrl(event.target.value); setModels([]); setApiKey(""); }} /></label>
      <label>API 密钥<input aria-label="模型 API 密钥" type="password" autoComplete="off" style={field} value={apiKey} onChange={event => setApiKey(event.target.value)} placeholder="已配置时可留空；更换服务地址需要新密钥" /></label>
      <button type="button" disabled={busy || !baseUrl} onClick={() => void run("models")}>获取模型列表</button>
      <label>模型名称<input aria-label="模型名称" list="glint-model-list" style={field} value={model} onChange={event => setModel(event.target.value)} /><datalist id="glint-model-list">{models.map(item => <option key={item.id} value={item.id} />)}</datalist></label>
      <label>协议<select aria-label="模型协议" style={field} value={protocol} onChange={event => setProtocol(event.target.value)}><option value="auto">自动适配</option><option value="openai">OpenAI Chat Completions</option><option value="responses">OpenAI Responses</option><option value="anthropic">Anthropic Messages</option><option value="gemini">Gemini</option></select></label>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}><button type="button" disabled={busy || !baseUrl || !model} onClick={() => void run("save")}>保存配置</button><button type="button" disabled={busy} onClick={() => void run("test")}>测试已保存配置（一次模型调用）</button></div>
      <small>列表由服务端获取。自动适配仅在明确的端点不兼容错误后换协议；鉴权、额度、限流和超时错误不会循环重试。</small>
      {message && <p role="status">{message}</p>}
    </div>}
  </section>;
}
