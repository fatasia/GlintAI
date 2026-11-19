import { useEffect, useMemo, useState } from "react";
import { parseBrandPack, brandTheme, brandContrastIssues } from "@glintai/design-tokens/brand";
import { tokensToCssVariables } from "@glintai/design-tokens";
import "./ConnectionSettings.css";

const DRAFT_KEY = "glint:brand-draft:v1";
const PRESET_HEX = /^#[0-9a-fA-F]{6}$/;

export function BrandStudio() {
  const draft = (() => { try { return JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "null"); } catch { return null; } })();
  const [name, setName] = useState(draft?.name ?? "我的品牌");
  const [logoText, setLogoText] = useState(draft?.logoText ?? "");
  const [accent, setAccent] = useState(draft?.colors?.accent ?? "#e0533d");
  const [bg, setBg] = useState(draft?.colors?.bg ?? "#1a1214");
  const [text, setText] = useState(draft?.colors?.text ?? "#fff5f0");
  const [copied, setCopied] = useState("");

  const parsed = useMemo(() => parseBrandPack({ name, colors: { accent, bg, text }, ...(logoText.trim() ? { logoText: logoText.trim() } : {}) }), [name, logoText, accent, bg, text]);
  const merged = useMemo(() => (parsed.pack ? brandTheme("glint-dark", parsed.pack) : null), [parsed]);
  const issues = [...(parsed.pack ? [] : parsed.issues), ...(merged?.issues ?? [])];
  const css = merged ? tokensToCssVariables(merged.theme) : "";

  useEffect(() => { try { if (parsed.pack) localStorage.setItem(DRAFT_KEY, JSON.stringify(parsed.pack)); } catch { /* quota/unavailable: editing continues in memory */ } }, [parsed]);

  const download = () => {
    if (!parsed.pack) return;
    const blob = new Blob([JSON.stringify(parsed.pack, null, 2)], { type: "application/json" });
    const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = "brand.json"; link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 5000);
  };
  const copyCss = async () => {
    try { await navigator.clipboard.writeText(css); setCopied("CSS 已复制"); setTimeout(() => setCopied(""), 2000); }
    catch { setCopied("复制失败：请手动选择下方文本"); setTimeout(() => setCopied(""), 3000); }
  };
  const swatch = merged?.theme.colors;
  const hexField = (labelText: string, value: string, onChange: (next: string) => void) => <label className="g-form-row"><span>{labelText}</span>
    <span className="brand-hex">
      <input type="color" aria-label={`${labelText} 选色`} value={PRESET_HEX.test(value) ? value : "#000000"} onChange={event => onChange(event.target.value)} className="brand-swatch-input" />
      <input className="g-field g-num brand-hex-value" aria-label={`${labelText} 十六进制`} value={value} onChange={event => onChange(event.target.value)} />
    </span>
  </label>;

  return <section aria-label="品牌工坊" className="tool-page">
    <header className="tool-page-head">
      <span className="g-label">品牌 · 色与字</span>
      <h3 className="g-title" style={{ margin: 0 }}>品牌工坊</h3>
      <p className="g-sub">定一套颜色与文字标，实时检查对比度，导出品牌包与 CSS 变量。</p>
    </header>

    <div className="tool-block">
      <div className="tool-block-head"><h3>命名</h3><span className="g-label">名称 · 文字标</span></div>
      <div className="tool-grid-2">
        <label className="g-form-row"><span>品牌名</span><input className="g-field" aria-label="品牌名" value={name} maxLength={60} onChange={event => setName(event.target.value)} /></label>
        <label className="g-form-row"><span>文字标（可选）</span><input className="g-field" aria-label="文字标" value={logoText} maxLength={24} placeholder="例：山茶" onChange={event => setLogoText(event.target.value)} /></label>
      </div>
    </div>

    <div className="tool-block">
      <div className="tool-block-head"><h3>色板</h3><span className="g-label g-num">3 色</span></div>
      <div className="tool-grid-2">
        {hexField("强调色 accent", accent, setAccent)}
        {hexField("背景 bg", bg, setBg)}
        {hexField("正文 text", text, setText)}
      </div>
    </div>

    {swatch && <div aria-label="品牌色卡" className="brand-proof" style={{ background: swatch.bg, border: `1px solid ${swatch.border}`, color: swatch.text }}>
      <div className="brand-proof-line">
        {parsed.pack?.logoText && <span style={{ padding: "3px 11px", borderRadius: 999, background: swatch.accent, color: swatch.bg, fontWeight: 700, fontSize: 13 }}>{parsed.pack.logoText}</span>}
        <strong style={{ fontSize: 17, letterSpacing: "-0.01em" }}>标题文字样例 · {parsed.pack?.name}</strong>
        <span style={{ color: swatch.textMuted, fontSize: 12.5 }}>弱化文字样例 · {name}</span>
      </div>
      <div className="brand-proof-actions">
        <span style={{ padding: "7px 15px", borderRadius: 8, background: swatch.accent, color: swatch.bg, fontSize: 12.5, fontWeight: 600 }}>强调按钮</span>
        <span style={{ padding: "7px 15px", borderRadius: 8, border: `1px solid ${swatch.border}`, fontSize: 12.5 }}>次级按钮</span>
        <span style={{ padding: "7px 15px", borderRadius: 8, background: swatch.surface, color: swatch.accent, fontSize: 12.5 }}>accent 文字</span>
      </div>
    </div>}

    {issues.length > 0 && <div role="alert" className="tool-alert">
      <strong>可读性告警（不阻断，但建议修正）</strong>
      {issues.map(issue => <span key={issue}>· {issue}</span>)}
    </div>}

    <div className="tool-actions">
      <button type="button" className="g-btn g-btn--primary" disabled={!parsed.pack} onClick={download}>下载 brand.json</button>
      <button type="button" className="g-btn g-btn--quiet" disabled={!merged} onClick={() => void copyCss()}>复制 CSS 变量</button>
      {copied && <span role="status" className="tool-note">{copied}</span>}
    </div>

    {css && <details className="tool-details">
      <summary>CSS 变量（可直接贴进工程 theme 或全局样式）</summary>
      <pre aria-label="品牌 CSS 变量" className="tool-code">{css}</pre>
    </details>}
  </section>;
}
