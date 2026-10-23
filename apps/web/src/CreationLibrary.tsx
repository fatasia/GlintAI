import { lazy, Suspense, useMemo, useState, type CSSProperties } from "react";
import { getCreationPack, instantiateCreationPack, listCreationPacks, type CreationPackInstance } from "@glintai/composer/creation-packs";
import { PreviewBoundary } from "./PreviewBoundary";
import { ImportedPackLibrary } from "./ImportedPackLibrary";

const Preview = lazy(() => import("./ProjectPreview"));
const button: CSSProperties = { color: "inherit", background: "var(--surface-2, transparent)", border: "1px solid currentColor", borderRadius: 8, padding: "10px 14px", font: "inherit", cursor: "pointer" };
const field: CSSProperties = { ...button, width: "100%", minWidth: 0, boxSizing: "border-box", cursor: "text" };

export function CreationLibrary({ onUse, disabled = false }: { onUse(instance: CreationPackInstance): void; disabled?: boolean }) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<CreationPackInstance | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [consent, setConsent] = useState(false);
  const packs = useMemo(() => listCreationPacks(query), [query]);
  const pack = selected ? getCreationPack(selected) : undefined;
  const select = (id: string) => {
    if (disabled) return;
    const next = getCreationPack(id);
    if (!next) return;
    setSelected(id); setValues(Object.fromEntries(next.inputs.map(input => [input.id, input.defaultValue])));
    setPreview(null); setError(""); setNotice(""); setConsent(false);
  };
  const buildPreview = () => {
    if (!pack || disabled) return;
    try {
      const instance = instantiateCreationPack(pack.id, values, { projectId: pack.preview.projectId });
      setPreview(instance); setError(""); setNotice("无声预览已准备，点击播放器播放；不会联网或扣费。");
    } catch (error) { setPreview(null); setError(error instanceof Error ? error.message : "请检查输入后重试"); }
  };
  const usePack = () => {
    if (!pack || !consent || disabled) return;
    try {
      const instance = instantiateCreationPack(pack.id, values);
      onUse(instance);
      setNotice(`已用「${pack.title}」创建新的可编辑工程，版本 ${instance.pack.version}。`); setError(""); setConsent(false);
    } catch (error) { setError(error instanceof Error ? error.message : "无法创建工程，请重试"); }
  };
  return <section aria-label="创作库" style={{ display: "grid", gap: 14, minWidth: 0 }}>
    <div><h3 style={{ margin: "0 0 6px" }}>想做什么？选一个开始</h3>
      <p style={{ margin: 0 }}>本地内置创作包，把版式、动效和步骤组合好。这里的示例文字和数字不是已核验事实，请替换成自己的内容。</p></div>
    <label>搜索想要的结果<input aria-label="搜索创作包" type="search" value={query} onChange={event => setQuery(event.target.value)} style={field} placeholder="商品广告、品牌、数据、教程…" /></label>
    <div role="group" aria-label="创作包目录" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 210px), 1fr))", gap: 10 }}>
      {packs.map(item => <button key={item.id} type="button" aria-pressed={selected === item.id} disabled={disabled}
        style={{ ...button, textAlign: "left", opacity: disabled ? 0.5 : 1 }} onClick={() => select(item.id)}>
        <strong style={{ display: "block", marginBottom: 6 }}>{item.title}</strong>
        <span>{item.description}</span><small style={{ display: "block", marginTop: 8 }}>{item.tags.join(" · ")} · v{item.version}</small>
      </button>)}
    </div>
    {packs.length === 0 && <p role="status">没有找到匹配的创作包。试试“商品”“品牌”“数据”或“教程”。</p>}
    {pack && <fieldset disabled={disabled} style={{ display: "grid", gap: 12, minWidth: 0, margin: 0, border: "1px solid currentColor", borderRadius: 10, padding: 14 }}>
      <legend>{pack.title} · 填入你的内容</legend>
      {pack.inputs.map(input => <label key={input.id}>{input.label}{input.required ? "（必填）" : "（选填）"}
        <input aria-label={input.label} required={input.required} maxLength={input.maxLength} value={values[input.id] ?? ""} style={field}
          onChange={event => { setValues(current => ({ ...current, [input.id]: event.target.value })); setPreview(null); setConsent(false); setNotice(""); }} />
      </label>)}
      <small>来源：{pack.author} · 许可：{pack.license} · 固定版本 {pack.version} · 本地生成，无外部服务权限。</small>
      <button type="button" style={button} onClick={buildPreview}>先看无声预览</button>
      {preview && <PreviewBoundary><Suspense fallback={<p role="status">正在加载预览…</p>}><Preview project={preview.project} /></Suspense></PreviewBoundary>}
      <label style={{ display: "flex", alignItems: "start", gap: 8 }}><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />创建新工程并切换编辑；不会修改原工程。请先保存正在编辑的内容。</label>
      <button type="button" disabled={!consent || disabled} onClick={usePack} style={{ ...button, opacity: !consent || disabled ? 0.5 : 1, cursor: !consent || disabled ? "not-allowed" : "pointer" }}>用这个创作</button>
    </fieldset>}
    {error && <p role="alert" style={{ margin: 0, overflowWrap: "anywhere" }}>{error}</p>}
    {notice && <p role="status" style={{ margin: 0 }}>{notice}</p>}
    <details><summary style={{ cursor: "pointer" }}>导入与管理我的创作包</summary>
      <ImportedPackLibrary onUse={onUse} disabled={disabled} />
    </details>
    <small>导入包仅支持无外部依赖的数据型配方；可执行插件与第三方模型安装未开放。</small>
  </section>;
}
