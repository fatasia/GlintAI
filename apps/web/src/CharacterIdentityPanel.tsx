import { appFetch as fetch } from "./app-url";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { bindCharacterToScene, forkCharacterIdentity, upgradeCharacterScene, saveCharacterIdentity, bindProductToScene, forkProductIdentity, upgradeProductScene, saveProductIdentity, type AssetIdentity, type SceneScriptProject } from "@glintai/scenescript";

const button: CSSProperties = { color: "inherit", background: "var(--ink-3)", border: "1px solid var(--line-2)", borderRadius: 8, padding: "8px 12px", font: "inherit", cursor: "pointer" };
const field: CSSProperties = { boxSizing: "border-box", width: "100%", minWidth: 0, padding: 9, borderRadius: 8, border: "1px solid var(--line-2)", background: "var(--ink-2)", color: "inherit", font: "inherit" };
const images = /^[a-zA-Z0-9_-]{1,100}\.(?:png|jpg|webp)$/;
type Draft = { id: string; name: string; version: string; description: string; voice: string; image: string };
const empty = (kind: "character" | "product"): Draft => ({ id: `${kind}-${crypto.randomUUID().slice(0, 8)}`, name: "", version: "v1", description: "", voice: "", image: "" });

/** User-created character identities; no model submission or automatic replacement. */
export function CharacterIdentityPanel({ project, sceneId, onChange, onApprove, canApprove, kind = "character" }: { project: SceneScriptProject; sceneId: string; onChange(project: SceneScriptProject): void; onApprove?: (id: string) => Promise<boolean>; canApprove?: boolean; kind?: "character" | "product" }) {
  const label = kind === "character" ? "角色" : "商品";
  const [draft, setDraft] = useState<Draft>(() => empty(kind)), [selected, setSelected] = useState(""), [items, setItems] = useState<string[]>([]), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const controller = useRef<AbortController | null>(null);
  const [approving, setApproving] = useState(false);
  useEffect(() => () => controller.current?.abort(), []);
  const characters = (project.assets ?? []).filter(asset => asset.kind === kind);
  const identity = characters.find(asset => asset.id === selected);
  useEffect(() => {
    if (identity?.approval) setDraft({ id: identity.id, name: identity.name, version: identity.version, description: identity.description ?? "", voice: identity.voice ?? "", image: identity.refs?.[0]?.replace(/^assets\//, "") ?? "" });
  }, [identity]);
  const dirty = Boolean(identity && !identity.approval && (draft.name.trim() !== identity.name || draft.description.trim() !== (identity.description ?? "") || draft.voice.trim() !== (identity.voice ?? "") || draft.image !== (identity.refs?.[0]?.replace(/^assets\//, "") ?? "")));
  const scene = project.scenes.find(item => item.id === sceneId);
  const set = (key: keyof Draft, value: string) => setDraft(current => ({ ...current, [key]: value }));
  const refresh = async () => {
    controller.current?.abort(); const current = new AbortController(); controller.current = current;
    try {
      const response = await fetch("/api/media/library", { signal: AbortSignal.any([current.signal, AbortSignal.timeout(15000)]) });
      if (!response.ok) throw new Error(); const data = await response.json();
      if (!current.signal.aborted) setItems(Array.isArray(data.assets) ? data.assets.flatMap((asset: { name?: unknown }) => typeof asset.name === "string" && images.test(asset.name) ? [asset.name] : []) : []);
    } catch { if (!current.signal.aborted) setError("无法读取素材库，请刷新后重试。"); }
  };
  const apply = (fn: () => SceneScriptProject, text: string) => {
    try { const next = fn(); onChange(next); setError(""); setNotice(text); return true; }
    catch (cause) { setError(cause instanceof Error ? cause.message : "角色资产未修改。"); return false; }
  };
  const select = (id: string) => {
    if (!id) { create(); return; }
    setSelected(id); const asset = characters.find(item => item.id === id);
    if (asset) setDraft({ id: asset.id, name: asset.name, version: asset.version, description: asset.description ?? "", voice: asset.voice ?? "", image: asset.refs?.[0]?.replace(/^assets\//, "") ?? "" });
  };
  const create = () => { setSelected(""); setDraft(empty(kind)); setError(""); setNotice(""); };
  return <details aria-label={`${label}资产`} onToggle={event => { if (event.currentTarget.open) void refresh(); }}>
    <summary style={{ cursor: "pointer" }}>{label}资产与批准</summary>
    <div style={{ display: "grid", gap: 8, paddingTop: 10, minWidth: 0 }}>
      <small>{kind === "character" ? "保存角色外观、素材库参考图和音色 ID；批准后锁定该版本。参考图不会自动用于生成，音色在绑定镜头时显式写入。" : "保存商品描述和素材库参考图；批准后锁定该版本。参考图须显式选择发送，绑定不会修改镜头音色。"}</small>
      {characters.length > 0 && <label>已有{label}<select aria-label={`选择${label}资产`} style={field} value={selected} onChange={event => select(event.target.value)}><option value="">新{label}</option>{characters.map(asset => <option key={asset.id} value={asset.id}>{asset.name} · {asset.version}{asset.approval ? " · 已批准" : " · 草稿"}</option>)}</select></label>}
      <button type="button" style={button} onClick={create}>新建{label}</button>
      <fieldset disabled={Boolean(identity?.approval || project.frozen)} style={{ display: "grid", gap: 8, margin: 0, border: "1px solid var(--line-2)", borderRadius: 8, minWidth: 0 }}>
        <legend>{identity?.approval ? "已批准" : `${label}草稿`}</legend>
        <label>{label}名<input aria-label={`${label}名称`} style={field} maxLength={120} value={draft.name} onChange={event => set("name", event.target.value)} /></label>
        <label>{kind === "character" ? "外观与服饰" : "商品描述"}<textarea aria-label={kind === "character" ? "角色外观" : "商品描述"} style={field} maxLength={2000} value={draft.description} onChange={event => set("description", event.target.value)} /></label>
        {kind === "character" && <label>音色 ID<input aria-label="角色音色" style={field} maxLength={128} value={draft.voice} onChange={event => set("voice", event.target.value)} /></label>}
        <label>参考图<select aria-label={`${label}参考图`} style={field} value={draft.image} onChange={event => set("image", event.target.value)}><option value="">选择素材库图片</option>{draft.image && !items.includes(draft.image) && <option value={draft.image}>{draft.image} · 未在素材库找到</option>}{items.map(name => <option key={name} value={name}>{name}</option>)}</select></label>
        <button type="button" style={button} disabled={!draft.name.trim()} onClick={() => {
          const existing = characters.find(asset => asset.id === draft.id);
          const rest = existing?.refs?.slice(1) ?? [];
          const value: AssetIdentity = { id: draft.id, kind, name: draft.name.trim(), version: draft.version, ...(existing?.derivedFrom ? { derivedFrom: existing.derivedFrom } : {}), ...(draft.description.trim() ? { description: draft.description.trim() } : {}), ...(draft.voice.trim() ? { voice: draft.voice.trim() } : {}), ...(draft.image ? { refs: [`assets/${draft.image}`, ...rest] } : rest.length ? { refs: rest } : {}) };
          if (apply(() => kind === "character" ? saveCharacterIdentity(project, value) : saveProductIdentity(project, value), `${label}草稿已保存到工程，可撤销。`)) setSelected(draft.id);
        }}>保存{label}草稿</button>
      </fieldset>
      {identity && <small>版本 {identity.version} · {identity.id} · {identity.approval ? "已批准，编辑已锁定" : "草稿，尚未批准"}</small>}
      {identity && !identity.approval && <button type="button" style={button} disabled={Boolean(project.frozen || dirty || approving || !canApprove || !onApprove || identity.refs?.length !== 1 || !items.includes(identity.refs[0]!.replace(/^assets\//, "")))} onClick={() => void (async () => {
        if (!onApprove) return;
        setApproving(true); setError("");
        try { if (await onApprove(identity.id)) { await refresh(); setNotice(`${label}已批准，已保存图片副本和摘要；副本仍可能被外部修改。`); } else setError("批准未确认；请检查共享工程状态，必要时恢复原提交。"); }
        catch { setError("批准未确认；请检查共享工程状态，必要时恢复原提交。"); }
        finally { setApproving(false); }
      })()} title="先保存草稿并同步共享工程，再批准">批准{label}版本</button>}
      {identity?.approval && <button type="button" style={button} disabled={Boolean(project.frozen)} onClick={() => {
        const id = `${kind}-${crypto.randomUUID().slice(0, 8)}`;
        try {
          const next = kind === "character" ? forkCharacterIdentity(project, identity.id, id) : forkProductIdentity(project, identity.id, id), created = next.assets!.find(asset => asset.id === id)!;
          onChange(next); setSelected(id); setDraft({ id, name: created.name, version: created.version, description: created.description ?? "", voice: created.voice ?? "", image: created.refs?.[0]?.replace(/^assets\//, "") ?? "" });
          setError(""); setNotice("新版本草稿已创建，旧版本和所有镜头不变；保存并批准后可逐镜替换。");
        } catch (cause) { setError(cause instanceof Error ? cause.message : "无法创建角色版本。"); }
      }}>新建{label}版本草稿</button>}
      {dirty && <small>草稿有未保存修改，请先保存再批准。</small>}
      {identity?.approval && <button type="button" style={button} disabled={Boolean(project.frozen || !scene || scene.locked || scene.assetRefs?.some(ref => ref.assetId === identity.id))} onClick={() => apply(() => kind === "character" ? bindCharacterToScene(project, sceneId, identity.id) : bindProductToScene(project, sceneId, identity.id), kind === "character" ? "已绑定当前镜头并设置音色，可撤销。" : "商品已绑定当前镜头，音色不变，可撤销。")} >{kind === "character" ? "绑定当前镜头并设置音色" : "绑定商品到当前镜头"}</button>}
      {identity?.approval && identity.derivedFrom && <button type="button" style={button} disabled={Boolean(project.frozen || !scene || scene.locked || !scene.assetRefs?.some(ref => ref.assetId === identity.derivedFrom!.assetId && ref.version === identity.derivedFrom!.version) || scene.assetRefs?.some(ref => ref.assetId === identity.id))} onClick={() => apply(() => kind === "character" ? upgradeCharacterScene(project, sceneId, identity.id) : upgradeProductScene(project, sceneId, identity.id), kind === "character" ? "当前镜头已切换角色版本并设置音色；其他镜头不变。" : "当前镜头已切换商品版本；其他镜头和音色不变。")} >仅替换当前镜头的旧版本</button>}
      {identity?.approval && <small>{kind === "character" ? "绑定会替换当前镜头音色。" : "绑定不会修改当前镜头音色。"}{identity.approval.refSha256 ? "批准图片按内容摘要保存；发送前会重新校验。" : "旧批准未绑定图片内容；需新建版本并重新批准才能发送参考图。"}</small>}
      {error && <p role="alert" style={{ margin: 0 }}>{error}</p>}{notice && <p role="status" style={{ margin: 0 }}>{notice}</p>}
    </div>
  </details>;
}
