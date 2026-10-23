import { useEffect, useState, type CSSProperties } from "react";
import type { SceneScriptProject } from "@glintai/scenescript";
import { makeCreationPack } from "@glintai/composer/exported-packs";
import { downloadJson } from "./editor-model";
import { installImportedPack } from "./imported-pack-store";

const button: CSSProperties = { background: "transparent", color: "inherit", border: "1px solid currentColor", borderRadius: 8, padding: "8px 12px", font: "inherit" };
const field: CSSProperties = { boxSizing: "border-box", width: "100%", minWidth: 0, background: "transparent", color: "inherit", border: "1px solid currentColor", borderRadius: 8, padding: 8, font: "inherit" };
const unsupported = "无法生成创作包：仅支持最多 20 个结构化文字或图表镜头、128 KB 以内的数据配方；不支持素材、图片、视频、音频、音乐、音效或外部引用。请保留原工程，另建纯数据配方后重试，不会自动删减内容。";

export function SaveCreationPack({ project, onSaved }: { project: SceneScriptProject; onSaved?: () => void }) {
  const [title, setTitle] = useState(project.title);
  const [author, setAuthor] = useState("");
  const [license, setLicense] = useState("仅供本人使用");
  const [version, setVersion] = useState("1.0.0");
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    setTitle(project.title); setConfirmed(false); setError(""); setNotice("");
  }, [project.id]);

  const run = (action: "install" | "download") => {
    if (!confirmed) return;
    setError(""); setNotice("");
    if (!title.trim() || !author.trim() || !license.trim()) {
      setError("请填写创作包名称、作者和你声明的使用许可。"); return;
    }
    if ([title, author, license].some(value => value.trim().length > 120)) {
      setError("创作包名称、作者和许可各不能超过 120 个字符，请缩短后重试。"); return;
    }
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version.trim())) {
      setError("版本请填写如 1.0.0 的三段数字，不使用前导零或预发布后缀。"); return;
    }
    if (typeof globalThis.crypto?.randomUUID !== "function") {
      setError("当前浏览器无法生成安全的创作包 ID，请使用支持安全随机 ID 的浏览器后重试。"); return;
    }
    let pack;
    try {
      const name = title.trim();
      pack = makeCreationPack(project, {
        id: `creation-${globalThis.crypto.randomUUID()}`, title: name, author: author.trim(),
        license: license.trim(), packVersion: version.trim(), description: `${name} 的可编辑配方`, tags: [],
      });
    } catch { setError(unsupported); return; }
    if (action === "install") {
      try { installImportedPack(pack); }
      catch { setError("未保存到创作库：本机存储可能已满、不可用或创作包数量已达上限。请备份并检查存储，也可以单独下载创作包 JSON。"); return; }
      setNotice(`已将「${pack.title}」保存到本机创作库；原工程未修改。`);
      onSaved?.();
    } else {
      try { downloadJson(`${pack.id}.creation-pack.json`, pack); }
      catch { setError("无法启动下载，请检查浏览器下载权限后重试；本机创作库未改变。"); return; }
      setNotice("已发起创作包 JSON 下载；未添加到本机创作库，请检查浏览器下载记录。");
    }
  };
  return <details onKeyDown={event => {
    if (event.key === "Escape") { event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); }
  }}>
    <summary style={{ cursor: "pointer" }}>存为创作包</summary>
    <div style={{ display: "grid", gap: 10, paddingTop: 12, minWidth: 0 }}>
      <small>将当前工程保存为可编辑的数据配方，不打包素材或执行代码。镜头私有备注会移除；旁白和画面文字会保留，请先检查其中的私人信息。许可仅由你声明，不代表平台认证。</small>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 180px), 1fr))", gap: 8 }}>
        <label>创作包名称<input style={field} value={title} maxLength={120} onChange={event => { setTitle(event.target.value); setNotice(""); }} /></label>
        <label>作者<input aria-label="创作包作者" style={field} value={author} maxLength={120} placeholder="你的署名" onChange={event => { setAuthor(event.target.value); setNotice(""); }} /></label>
        <label>使用许可（自行声明）<input style={field} value={license} maxLength={120} onChange={event => { setLicense(event.target.value); setNotice(""); }} /></label>
        <label>版本<input style={field} value={version} maxLength={40} placeholder="1.0.0" onChange={event => { setVersion(event.target.value); setNotice(""); }} /></label>
      </div>
      <label><input aria-label="确认创作包权利与隐私" type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />我确认拥有内容使用权，已检查并移除不应分享的私人信息，并确认上述许可。</label>
      <small>保存到创作库和下载是独立操作；下载不会自动添加到创作库。</small>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <button type="button" disabled={!confirmed} title={!confirmed ? "请先确认内容权利、私人信息和许可" : undefined} style={{ ...button, opacity: confirmed ? 1 : 0.5, cursor: confirmed ? "pointer" : "not-allowed" }} onClick={() => run("install")}>保存到创作库</button>
        <button type="button" disabled={!confirmed} title={!confirmed ? "请先确认内容权利、私人信息和许可" : undefined} style={{ ...button, opacity: confirmed ? 1 : 0.5, cursor: confirmed ? "pointer" : "not-allowed" }} onClick={() => run("download")}>下载创作包 JSON</button>
      </div>
      {error && <p role="alert" style={{ margin: 0, overflowWrap: "anywhere" }}>{error}</p>}
      {notice && <p role="status" style={{ margin: 0, overflowWrap: "anywhere" }}>{notice}</p>}
    </div>
  </details>;
}
