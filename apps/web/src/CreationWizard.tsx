import { useState } from "react";
import { planToSource, type VideoPlan } from "@glintai/composer/plan";

const field = { width: "100%", minWidth: 0, padding: "10px 12px", borderRadius: 9, border: "1px solid #2b2b31", background: "#151518", color: "#f4f4f5", font: "inherit", fontSize: 13 };
const button = { border: "1px solid #3f3f46", borderRadius: 8, background: "#1c1c21", color: "#e4e4e7", padding: "8px 12px", font: "inherit", fontSize: 12, cursor: "pointer" };

/**
 * Goal → audience → platform → shootable plan. The plan is data: every scene
 * is editable before composing, and composition reuses the offline composer
 * so the result lands in the same workbench as any other source.
 */
export function CreationWizard({ onCompose, disabled = false }: { onCompose(source: string, options: { template: string; theme: string; aspect: string }): void; disabled?: boolean }) {
  const [goal, setGoal] = useState("");
  const [audience, setAudience] = useState("");
  const [platform, setPlatform] = useState("16:9");
  const [seconds, setSeconds] = useState(15);
  const [material, setMaterial] = useState("");
  const [plan, setPlan] = useState<VideoPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const generate = async () => {
    if (!goal.trim() || busy) { if (!goal.trim()) setError("先写一句目标。"); return; }
    setBusy(true); setError(""); setPlan(null);
    try {
      const response = await fetch("/api/plan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ goal, audience, platform, seconds, material }), signal: AbortSignal.timeout(150_000) });
      const data = await response.json();
      if (!response.ok) throw new Error(typeof data?.error === "string" ? data.error : "规划失败");
      setPlan(data.plan);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "规划失败"); }
    finally { setBusy(false); }
  };
  const patchScene = (index: number, patch: Partial<VideoPlan["scenes"][number]>) => {
    if (!plan) return;
    setPlan({ ...plan, scenes: plan.scenes.map((scene, current) => current === index ? { ...scene, ...patch } : scene) });
  };

  return <section aria-label="创作向导" style={{ display: "grid", gap: 10 }}>
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 2fr) minmax(0, 1fr) auto auto", gap: 8 }}>
      <label style={{ display: "grid", gap: 4, fontSize: 11, color: "#a1a1aa" }}>这条视频要达成什么<textarea aria-label="创作目标" rows={2} maxLength={500} style={field} value={goal} onChange={event => setGoal(event.target.value)} placeholder="例：给咖啡店开业做一条 15 秒宣传，主打手冲和到店礼" /></label>
      <label style={{ display: "grid", gap: 4, fontSize: 11, color: "#a1a1aa" }}>给谁看<input aria-label="目标受众" maxLength={200} style={field} value={audience} onChange={event => setAudience(event.target.value)} placeholder="例：周边居民、上班族" /></label>
      <label style={{ display: "grid", gap: 4, fontSize: 11, color: "#a1a1aa" }}>画幅<select aria-label="目标画幅" style={field} value={platform} onChange={event => setPlatform(event.target.value)}><option value="16:9">横屏 16:9</option><option value="9:16">竖屏 9:16</option><option value="1:1">方形 1:1</option></select></label>
      <label style={{ display: "grid", gap: 4, fontSize: 11, color: "#a1a1aa" }}>秒数<input aria-label="目标时长" type="number" min={5} max={120} style={{ ...field, width: 76 }} value={seconds} onChange={event => setSeconds(Number(event.target.value))} /></label>
    </div>
    <label style={{ display: "grid", gap: 4, fontSize: 11, color: "#a1a1aa" }}>素材要点（可选）<textarea aria-label="素材要点" rows={2} maxLength={3000} style={field} value={material} onChange={event => setMaterial(event.target.value)} placeholder="时间、地点、卖点、数字；没有就留空，不会编造。" /></label>
    <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
      <button type="button" style={{ ...button, background: "#f4f4f5", color: "#09090b", fontWeight: 600 }} disabled={busy || disabled} onClick={() => void generate()}>{busy ? "正在规划…" : "生成计划"}</button>
      <small style={{ color: "#8b8b95" }}>需要已配置的文本模型；计划只是数据，每一条都能改。</small>
      {error && <span role="alert" style={{ color: "#fca5a5", fontSize: 12 }}>{error}</span>}
    </div>
    {plan && <div style={{ display: "grid", gap: 10, paddingTop: 4 }}>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "baseline" }}>
        <strong style={{ fontSize: 14 }}>{plan.title}</strong>
        <small style={{ color: "#8b8b95" }}>{plan.hook} · {plan.audience} · {plan.totalSeconds}s · {plan.platform} · {plan.theme}</small>
      </div>
      <ol style={{ display: "grid", gap: 8, margin: 0, padding: 0, listStyle: "none" }}>
        {plan.scenes.map((scene, index) => <li key={index} style={{ display: "grid", gap: 6, padding: 10, borderRadius: 10, border: "1px solid #26262b", background: "#101013" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ color: "#7c8cff", fontSize: 11 }}>镜头 {index + 1}</span>
            <input aria-label={`镜头 ${index + 1} 目标`} value={scene.goal} maxLength={200} onChange={event => patchScene(index, { goal: event.target.value })} style={{ ...field, flex: "1 1 200px", padding: "5px 8px" }} />
            <label style={{ display: "flex", gap: 4, alignItems: "center", fontSize: 11, color: "#a1a1aa" }}>{scene.seconds}s<input aria-label={`镜头 ${index + 1} 时长`} type="number" min={1} max={120} value={scene.seconds} onChange={event => patchScene(index, { seconds: Math.max(1, Math.min(120, Number(event.target.value) || 1)) })} style={{ ...field, width: 64, padding: "5px 8px" }} /></label>
          </div>
          <label style={{ display: "grid", gap: 3, fontSize: 11, color: "#a1a1aa" }}>口播<textarea aria-label={`镜头 ${index + 1} 口播`} rows={2} maxLength={400} value={scene.narration} onChange={event => patchScene(index, { narration: event.target.value })} style={{ ...field, fontFamily: "inherit" }} /></label>
          <label style={{ display: "grid", gap: 3, fontSize: 11, color: "#a1a1aa" }}>画面<textarea aria-label={`镜头 ${index + 1} 画面`} rows={2} maxLength={300} value={scene.visual} onChange={event => patchScene(index, { visual: event.target.value })} style={{ ...field, fontFamily: "inherit" }} /></label>
        </li>)}
      </ol>
      <button type="button" style={{ justifySelf: "start", border: "1px solid #f4f4f5", borderRadius: 999, padding: "8px 16px", background: "#f4f4f5", color: "#09090b", font: "inherit", fontSize: 13, fontWeight: 600, cursor: "pointer" }} onClick={() => onCompose(planToSource(plan), { template: "explainer", theme: plan.theme, aspect: plan.platform })}>用这个计划开始制作</button>
    </div>}
  </section>;
}
