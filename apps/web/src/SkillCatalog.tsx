import { appFetch as fetch } from "./app-url";
import { useEffect, useState } from "react";
import "./ConnectionSettings.css";

interface Skill { id: string; name: string; description: string; path: string; source: string }

/**
 * Local skills catalog. It lists what is actually installed under skills/;
 * remote marketplace installs and signature checks are deliberately absent.
 */
export function SkillCatalog() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/skills", { signal: controller.signal }).then(async response => {
      const data = await response.json();
      if (!response.ok || !Array.isArray(data.skills)) throw new Error("Skills 目录读取失败");
      if (!controller.signal.aborted) setSkills(data.skills);
    }).catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Skills 目录读取失败"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);
  const copyPath = async (skill: Skill) => {
    try { await navigator.clipboard.writeText(skill.path); setNotice(`已复制 ${skill.path}`); }
    catch { setNotice(`路径：${skill.path}`); }
  };
  return <section aria-label="Skills 目录" className="tool-page">
    <header className="tool-page-head">
      <span className="g-label">技能 · 本机</span>
      <h2 className="g-title" style={{ margin: 0 }}>Skills 目录</h2>
      <p className="g-sub">只列出本项目 <code>skills/</code> 下真实存在的技能；远程安装与签名校验未开放。</p>
    </header>

    <section className="tool-block" aria-label="已安装技能">
      <div className="tool-block-head">
        <h3>已安装</h3>
        <span className="g-label g-num">{loading ? "读取中" : `${skills.length} 项`}</span>
      </div>
      {loading && <p role="status" className="g-loading" style={{ padding: 0 }}>正在读取本机 Skills…</p>}
      {error && <p role="alert" className="tool-alert">{error}</p>}
      {notice && <p role="status" className="tool-note">{notice}</p>}
      {!loading && !error && !skills.length && <div className="g-empty">
        <strong>本机还没有技能</strong>
        <p>把技能目录放进项目的 skills/ 后重新加载。</p>
      </div>}
      {!!skills.length && <ul className="tool-list">
        {skills.map(skill => <li key={skill.id} className="tool-list-row" aria-label={skill.name}>
          <div className="tool-row-head">
            <span className="tool-row-name">{skill.name}</span>
            <span className="g-label">{skill.source}</span>
          </div>
          <p className="tool-note" style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{skill.description || "无描述"}</p>
          <div className="tool-row-action">
            <code className="tool-path">{skill.path}</code>
            <button type="button" className="g-btn g-btn--sm g-btn--quiet" onClick={() => void copyPath(skill)}>复制路径</button>
          </div>
        </li>)}
      </ul>}
    </section>
  </section>;
}
