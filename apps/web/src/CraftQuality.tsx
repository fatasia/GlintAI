import { craftLint, lintVerdict } from "@glintai/composer/craft-lint";
import type { SceneScriptProject } from "@glintai/scenescript";

const VERDICT: Record<"green" | "yellow" | "red", { label: string; color: string }> = {
  green: { label: "结构可用", color: "#5eead4" },
  yellow: { label: "建议调整", color: "#fbbf24" },
  red: { label: "先修问题", color: "#f87171" },
};

/**
 * The same craft rules the CLI already refuses to ship on, surfaced where the
 * fix is cheapest. This is a storyboard check, not a pixel or audio review.
 */
export function CraftQuality({ project, onSelectScene }: { project: SceneScriptProject; onSelectScene?(id: string): void }) {
  const issues = craftLint(project);
  const verdict = VERDICT[lintVerdict(issues)];
  const order = new Map(project.scenes.map((scene, index) => [scene.id, index + 1]));
  return <section aria-label="剧本质量检查" style={{ display: "grid", gap: 8, padding: 12, border: "1px solid #2b2b31", borderRadius: 10 }}>
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <strong>剧本质量</strong>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 8px", borderRadius: 999, border: `1px solid ${verdict.color}55`, color: verdict.color, fontSize: 11 }}><span aria-hidden="true" style={{ width: 5, height: 5, borderRadius: "50%", background: verdict.color }} />{verdict.label}</span>
      <small style={{ color: "#8b8b95" }}>{issues.length ? `${issues.length} 条需要看一眼` : "没有结构问题"}</small>
    </div>
    {issues.length === 0
      ? <p style={{ margin: 0, color: "#a1a1aa", fontSize: 12, lineHeight: 1.6 }}>镜头长度、转场重音、镜头运动和结构密度都通过检查。</p>
      : <ul aria-label="质量问题列表" style={{ display: "grid", gap: 6, margin: 0, padding: 0, listStyle: "none" }}>
        {issues.map((issue, index) => {
          const sceneNumber = issue.sceneId ? order.get(issue.sceneId) : undefined;
          return <li key={`${issue.rule}-${index}`}>
            <button type="button" disabled={!sceneNumber || !onSelectScene} onClick={() => { if (issue.sceneId) onSelectScene?.(issue.sceneId); }}
              style={{ width: "100%", display: "grid", gridTemplateColumns: "auto minmax(0, 1fr)", gap: 8, textAlign: "left", padding: "7px 9px", borderRadius: 8, border: "1px solid #26262b", background: "#151518", color: "#d4d4d8", font: "inherit", fontSize: 12, lineHeight: 1.55, cursor: sceneNumber && onSelectScene ? "pointer" : "default" }}>
              <span style={{ color: issue.level === "error" ? "#f87171" : "#fbbf24", fontSize: 10, paddingTop: 2 }}>{issue.level === "error" ? "必修" : "建议"}{sceneNumber ? ` · 第 ${sceneNumber} 镜` : ""}</span>
              <span>{issue.message}</span>
            </button>
          </li>;
        })}
      </ul>}
    <small style={{ color: "#8b8b95", fontSize: 11, lineHeight: 1.55 }}>只检查剧本结构；成片像素、首帧与技术规格在导出后检查，不代表视觉已人工验收。</small>
  </section>;
}
