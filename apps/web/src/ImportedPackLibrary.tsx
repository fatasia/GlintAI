import { useEffect, useRef, useState, type CSSProperties } from "react";
import { materializeImportedPack, parseImportedPack, type ImportedCreationPack } from "@glintai/composer/imported-packs";
import type { CreationPackInstance } from "@glintai/composer/creation-packs";
import { IMPORTED_PACKS_CHANGED, installImportedPack, readImportedPacks, removeImportedPack, replaceImportedPack } from "./imported-pack-store";

const button: CSSProperties = { background: "transparent", color: "inherit", border: "1px solid currentColor", borderRadius: 8, padding: "8px 12px", font: "inherit", cursor: "pointer" };
export function ImportedPackLibrary({ onUse, disabled = false }: { onUse(instance: CreationPackInstance): void; disabled?: boolean }) {
  const [packs, setPacks] = useState<ImportedCreationPack[]>([]);
  const [candidate, setCandidate] = useState<ImportedCreationPack | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reading, setReading] = useState(false);
  const file = useRef<HTMLInputElement | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    const refresh = () => {
      try { setPacks(readImportedPacks()); } catch { setError("无法读取本机创作包，请检查浏览器存储并先备份工程。"); }
    };
    refresh(); window.addEventListener(IMPORTED_PACKS_CHANGED, refresh); window.addEventListener("storage", refresh);
    return () => { generation.current++; window.removeEventListener(IMPORTED_PACKS_CHANGED, refresh); window.removeEventListener("storage", refresh); };
  }, []);
  const load = async (selected: File | undefined) => {
    const token = ++generation.current;
    if (!selected || disabled) return;
    setReading(true); setCandidate(null); setConfirmed(false); setError(""); setNotice("");
    try {
      if (selected.size > 128 * 1024 || !selected.name.toLowerCase().endsWith(".json")) throw new Error("请选择不超过 128 KB 的创作包 JSON 文件。");
      const text = await selected.text();
      if (token !== generation.current) return;
      setCandidate(parseImportedPack(JSON.parse(text)));
    } catch (error) { if (token === generation.current) setError(error instanceof Error ? error.message : "创作包格式不正确。"); }
    finally { if (token === generation.current) setReading(false); if (file.current) file.current.value = ""; }
  };
  const existing = candidate ? packs.find(pack => pack.id === candidate.id) : undefined;
  const sameVersion = Boolean(existing && existing.packVersion === candidate?.packVersion);
  const install = () => {
    if (!candidate || !confirmed || disabled) return;
    try {
      if (existing) {
        setPacks(replaceImportedPack(candidate));
        setNotice(`已把「${candidate.title}」更新到 v${candidate.packVersion}；已创建的工程不受影响。`);
      } else {
        setPacks(installImportedPack(candidate));
        setNotice(`已添加「${candidate.title}」，没有执行代码或联网。`);
      }
      setCandidate(null); setConfirmed(false); setError("");
    }
    catch (error) { setError(error instanceof Error ? error.message : "保存创作包失败，未确认添加。"); }
  };
  const use = (pack: ImportedCreationPack) => {
    if (disabled) return;
    try { onUse(materializeImportedPack(pack)); setNotice(`已从「${pack.title}」创建新工程。`); setError(""); }
    catch (error) { setError(error instanceof Error ? error.message : "无法创建新工程，请先保存现有工作。"); }
  };
  return <section aria-label="导入的创作包" style={{ display: "grid", gap: 10, minWidth: 0 }}>
    <h4 style={{ margin: 0 }}>我的创作包</h4>
    <small>只接收 Glint 数据型配方；不执行脚本，不安装模型，不读取外部素材。来源与许可由包作者声明，请自行确认使用权。</small>
    <input ref={file} aria-label="选择创作包 JSON" type="file" accept=".json,application/json" disabled={disabled || reading}
      onChange={event => void load(event.target.files?.[0])} />
    {reading && <p role="status">正在检查创作包…</p>}
    {candidate && <div style={{ display: "grid", gap: 8 }}>
      <strong>{candidate.title} · v{candidate.packVersion}</strong><span>{candidate.description}</span>
      <small>作者：{candidate.author} · 许可：{candidate.license} · {candidate.project.scenes.length} 个可编辑镜头</small>
      {existing && <p role="status" style={{ margin: 0 }}>本机已安装 v{existing.packVersion}。{sameVersion ? "相同版本不会重复添加；如需重装请先移除旧包。" : "确认后会替换旧版本；已创建的工程不会改变。"}</p>}
      <label><input type="checkbox" checked={confirmed} disabled={disabled} onChange={event => setConfirmed(event.target.checked)} />我已确认来源和许可，{existing ? "更新这个创作包" : "添加到本机创作库"}</label>
      <button type="button" style={{ ...button, opacity: !confirmed || disabled || sameVersion ? 0.5 : 1 }} disabled={!confirmed || disabled || sameVersion} onClick={install}>{existing ? `更新到 v${candidate.packVersion}` : "添加创作包"}</button>
    </div>}
    {!packs.length && <p style={{ margin: 0 }}>尚未导入创作包，可以先用上方内置包开始。</p>}
    {packs.map(pack => <div key={pack.id} style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
      <span style={{ flex: "1 1 180px", overflowWrap: "anywhere" }}>{pack.title} · v{pack.packVersion}<small style={{ display: "block" }}>{pack.author} · {pack.license}</small></span>
      <button type="button" disabled={disabled} style={button} onClick={() => use(pack)}>用「{pack.title}」创作</button>
      <button type="button" disabled={disabled} style={button} onClick={() => {
        if (disabled) return;
        try { setPacks(removeImportedPack(pack.id)); setNotice("创作包已移除，已有工程不受影响。"); }
        catch { setError("移除失败，请检查本机存储后重试。"); }
      }}>移除「{pack.title}」</button>
    </div>)}
    {error && <p role="alert" style={{ margin: 0, overflowWrap: "anywhere" }}>{error}</p>}
    {notice && <p role="status" style={{ margin: 0 }}>{notice}</p>}
  </section>;
}
