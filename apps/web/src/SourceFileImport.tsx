import { appFetch as fetch } from "./app-url";
import { useEffect, useRef, useState, type CSSProperties } from "react";

const MAX_BYTES = 256 * 1024;
const MAX_CHARS = 12000;
const button: CSSProperties = { border: "1px solid var(--line-2)", borderRadius: 8, background: "var(--ink-3)", color: "var(--paper-dim)", padding: "8px 12px", font: "inherit", cursor: "pointer" };

/** Read locally; applying a preview is a separate, explicit action. */
export function SourceFileImport({ onApply, replacesProject }: { onApply(text: string): void | boolean; replacesProject: boolean }) {
  const [preview, setPreview] = useState<{ name: string; text: string } | null>(null);
  const [error, setError] = useState("");
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => { generation.current++; request.current?.abort(); }, []);
  const read = async (file: File | undefined) => {
    request.current?.abort(); request.current = null; setLoading(false);
    const sequence = ++generation.current;
    setPreview(null); setError("");
    if (!file) return;
    try {
      if (!/\.(txt|md|markdown)$/i.test(file.name)) throw new Error("请选择 TXT 或 Markdown 文件。");
      if (file.size > MAX_BYTES) throw new Error("文件超过 256 KB，请先缩小文件。");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer()).replace(/^\uFEFF/, "");
      if (!text.trim()) throw new Error("文件没有可用正文。");
      if (text.length > MAX_CHARS) throw new Error("正文超过 12000 字，请先精简后导入。");
      if (generation.current === sequence) setPreview({ name: file.name, text });
    } catch (cause) {
      if (generation.current === sequence) setError(cause instanceof TypeError ? "文件不是有效的 UTF-8 文本。" : cause instanceof Error ? cause.message : "读取文件失败。");
    }
  };
  const readUrl = async () => {
    if (!url.trim() || loading) return;
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    const sequence = ++generation.current; setLoading(true); setError(""); setPreview(null);
    try {
      const response = await fetch("/api/source/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: url.trim() }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(25000)]) });
      const data = await response.json();
      if (!response.ok) throw new Error(typeof data?.error === "string" ? data.error : "链接读取失败。");
      if (typeof data?.text !== "string" || !data.text.trim() || data.text.length > MAX_CHARS) throw new Error("链接正文无效或超过 12000 字。");
      if (generation.current === sequence) setPreview({ name: "链接正文", text: data.text });
    } catch (cause) {
      if (generation.current === sequence) setError(cause instanceof Error ? cause.message : "链接读取失败。");
    } finally { if (generation.current === sequence) { setLoading(false); request.current = null; } }
  };
  return <div aria-label="资料文件导入" style={{ display: "grid", gap: 8, marginTop: 10, minWidth: 0 }}>
    <label>从文件读取资料（TXT / Markdown，UTF-8）<input aria-label="选择资料文件" type="file" style={{ maxWidth: "100%" }} accept=".txt,.md,.markdown,text/plain,text/markdown" onChange={event => { void read(event.currentTarget.files?.[0]); event.currentTarget.value = ""; }} /></label>
    <label>或读取公开 HTTPS 链接<input aria-label="资料链接" type="url" maxLength={2000} value={url} onChange={event => { generation.current++; request.current?.abort(); request.current = null; setLoading(false); setPreview(null); setError(""); setUrl(event.target.value); }} style={{ width: "100%", boxSizing: "border-box", minWidth: 0, padding: 8, borderRadius: 8, border: "1px solid var(--line-2)", background: "var(--ink-1)", color: "var(--paper)", font: "inherit" }} /></label>
    <small>读取会访问该网站；登录页面和扫描件可能无法提取正文。</small>
    <button type="button" style={{ ...button, justifySelf: "start" }} disabled={!url.trim() || loading} onClick={() => void readUrl()}>{loading ? "正在读取链接…" : "预览链接"}</button>
    {error && <p role="alert" style={{ margin: 0 }}>{error}</p>}
    {preview && <div style={{ display: "grid", gap: 8, minWidth: 0 }}>
      <strong style={{ overflowWrap: "anywhere" }}>导入预览 · {preview.name} · {preview.text.length} 字符</strong>
      <label>预览正文（可编辑）<textarea aria-label="资料文件预览" value={preview.text} maxLength={MAX_CHARS} onChange={event => setPreview({ ...preview, text: event.target.value })} rows={7} style={{ width: "100%", boxSizing: "border-box", whiteSpace: "pre-wrap", overflowWrap: "anywhere", minWidth: 0, resize: "vertical", padding: 10, border: "1px solid var(--line-2)", borderRadius: 8, font: "inherit", background: "var(--ink-1)", color: "var(--paper)" }} /></label>
      {!preview.text.trim() && <small role="alert">正文不能为空，请输入内容或取消导入。</small>}
      {replacesProject && <small>应用后将清除当前分镜；请先保存需要保留的工程。</small>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" style={button} disabled={!preview.text.trim()} onClick={() => { if (!preview.text.trim() || onApply(preview.text) === false) return; setPreview(null); setUrl(""); }}>替换资料</button>
        <button type="button" style={button} onClick={() => setPreview(null)}>取消导入</button>
      </div>
    </div>}
  </div>;
}
