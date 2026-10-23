import { useEffect, useState } from "react";

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
  return <section aria-label="Skills 目录" style={{ display: "grid", gap: 12, padding: 22 }}>
    <div style={{ display: "grid", gap: 4 }}><strong style={{ fontSize: 15 }}>Skills 市场 · 本机已安装</strong><small style={{ color: "#8b8b95", fontSize: 12 }}>只列出本项目 <code>skills/</code> 下真实存在的技能；远程安装、签名与权限预览未开放。</small></div>
    {loading && <p role="status" style={{ color: "#8b8b95", fontSize: 13 }}>正在读取本机 Skills…</p>}
    {error && <p role="alert" style={{ color: "#fca5a5", fontSize: 13 }}>{error}</p>}
    {notice && <p role="status" style={{ color: "#8b8b95", fontSize: 12 }}>{notice}</p>}
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 260px), 1fr))", gap: 10 }}>
      {skills.map(skill => <article key={skill.id} style={{ display: "grid", gap: 7, padding: 12, border: "1px solid #26262b", borderRadius: 12, background: "#101013", minWidth: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}><strong style={{ fontSize: 13, color: "#e4e4e7" }}>{skill.name}</strong><small style={{ color: "#8b8b95", fontSize: 10 }}>{skill.source}</small></div>
        <p style={{ margin: 0, color: "#a1a1aa", fontSize: 12, lineHeight: 1.55, display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{skill.description || "无描述"}</p>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}><code style={{ color: "#6f6f78", fontSize: 10, overflowWrap: "anywhere" }}>{skill.path}</code><button type="button" style={{ border: "1px solid #2b2b31", borderRadius: 999, background: "#1c1c21", color: "#a1a1aa", padding: "4px 9px", font: "inherit", fontSize: 11, cursor: "pointer" }} onClick={() => void copyPath(skill)}>复制路径</button></div>
      </article>)}
    </div>
  </section>;
}
