import { appFetch as fetch } from "./app-url";
import { useEffect, useRef, useState } from "react";
import { planToSource, VideoPlan } from "@glintai/composer/plan";
import { THEME_IDS } from "@glintai/composer/templates";
import { planVisuals, type VisualLayout, type VisualRelation, type VisualMotion } from "@glintai/composer/visual-plan";

const DRAFT_KEY = "glint:wizard-draft:v1";

const KIND_BADGES: Record<string, string> = { title: "标题", bullets: "要点", definition: "定义", comparison: "对比", quote: "引语", chart: "图表", diagram: "流程", image: "图片" };
const LAYOUT_BADGES: Record<VisualLayout, string> = { full: "全屏", "split-left": "左分屏", "split-right": "右分屏", "grid-2": "两栏", "grid-3": "三栏", "center-stack": "居中" };
const RELATION_BADGES: Record<VisualRelation, string> = { none: "", compare: "对比", flow: "流程", hierarchy: "层级", timeline: "时间线", "cause-effect": "因果" };
const MOTION_BADGES: Record<VisualMotion, string> = { static: "静止", "zoom-in": "推进", "zoom-out": "拉远", "pan-left": "缓移", reveal: "显现" };

/**
 * CREATE-04 zero-cost storyboard preview: plays the approved plan as a timed
 * card slideshow (shot visual + narration subtitle) entirely in the browser —
 * no model call, no render job, so comparing options costs nothing.
 */
function StoryboardPreview({ plan }: { plan: VideoPlan }) {
  const [open, setOpen] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [shot, setShot] = useState(0);
  const [speed, setSpeed] = useState(1);
  const current = plan.scenes[shot] ?? plan.scenes[0];
  // CREATE-08: the visual layer (layout / relation / motion) is derived on the
  // fly from the plan the user is editing, so badges follow every edit.
  const visuals = planVisuals(plan.scenes);
  const staged = visuals[shot];

  useEffect(() => {
    if (!playing) return;
    const seconds = (current?.seconds ?? 3) / speed;
    const timer = setTimeout(() => {
      setShot(index => index + 1 >= plan.scenes.length ? (setPlaying(false), index) : index + 1);
    }, seconds * 1000);
    return () => clearTimeout(timer);
  }, [playing, shot, speed, current?.seconds, plan.scenes.length]);

  if (!open) return <button type="button" className="g-btn g-btn--quiet cw-submit" onClick={() => { setOpen(true); setShot(0); setPlaying(true); }}>▶ 播放试片（零成本）</button>;
  return <div aria-label="分镜试片" className="cw-stage">
    <div className={`cw-stage-frame${plan.platform === "9:16" ? " cw-stage-frame--narrow" : ""}`} style={{ aspectRatio: plan.platform === "9:16" ? "9 / 16" : plan.platform === "1:1" ? "1 / 1" : "16 / 9" }} key={`${shot}`}>
      <div className="cw-stage-top">
        <span>镜头 {shot + 1}/{plan.scenes.length} · {KIND_BADGES[current?.kind ?? ""] ?? current?.kind} · {current?.seconds}s</span>
        <span>{plan.title}</span>
      </div>
      <p className="cw-stage-visual">{current?.visual}</p>
      <p className="cw-stage-narration">口播：{current?.narration}</p>
      {staged && <div aria-label="视觉规划" className="cw-badges">
        <span className="cw-badge">{LAYOUT_BADGES[staged.layout]}</span>
        {RELATION_BADGES[staged.relation] && <span className="cw-badge">{RELATION_BADGES[staged.relation]}</span>}
        <span className="cw-badge">{MOTION_BADGES[staged.motion]}</span>
        <span className="cw-reason">{staged.reason}</span>
      </div>}
      <div className="cw-timeline">
        {plan.scenes.map((scene, index) => <span key={index} className={`cw-tick${index < shot ? " cw-tick--past" : index === shot ? " cw-tick--now" : ""}`} style={{ flex: scene.seconds }} />)}
      </div>
    </div>
    <div className="cw-actions">
      <button type="button" aria-label={playing ? "暂停试片" : "播放试片"} className="g-btn g-btn--sm" onClick={() => setPlaying(value => !value)}>{playing ? "❙❙ 暂停" : "▶ 播放"}</button>
      <button type="button" aria-label="上一个镜头" className="g-btn g-btn--sm g-btn--icon" disabled={shot === 0} onClick={() => setShot(value => value - 1)}>‹</button>
      <button type="button" aria-label="下一个镜头" className="g-btn g-btn--sm g-btn--icon" disabled={shot >= plan.scenes.length - 1} onClick={() => setShot(value => value + 1)}>›</button>
      <label className="cw-speed">速度
        <select aria-label="试片速度" className="g-field" value={speed} onChange={event => setSpeed(Number(event.target.value))}><option value={1}>1×</option><option value={2}>2×</option><option value={4}>4×</option></select>
      </label>
      <button type="button" className="g-btn g-btn--sm g-btn--quiet" onClick={() => { setOpen(false); setPlaying(false); }}>关闭</button>
      <small className="cw-note">纯分镜预览，不调用模型、不渲染；确认后再点下方制作。</small>
    </div>
  </div>;
}

interface WizardDraft { goal: string; audience: string; platform: string; seconds: number; budgetCny: number | null; material: string; plans: VideoPlan[]; planIndex: number }

/** Restore the last draft; corrupt or foreign data is discarded, never crashes the wizard. */
function readDraft(): WizardDraft | null {
  try {
    const value = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "");
    if (typeof value?.goal !== "string") return null;
    // Older drafts stored one plan; treat it as a single-variant list.
    const candidates = Array.isArray(value.plans) ? value.plans : value.plan ? [value.plan] : [];
    const plans = candidates.flatMap((candidate: unknown) => {
      const parsed = VideoPlan.safeParse(candidate);
      return parsed.success ? [parsed.data] : [];
    });
    const planIndex = Number.isInteger(value.planIndex) ? Math.min(Math.max(0, value.planIndex), Math.max(0, plans.length - 1)) : Math.max(0, plans.length - 1);
    return {
      goal: value.goal,
      audience: typeof value.audience === "string" ? value.audience : "",
      platform: ["16:9", "9:16", "1:1"].includes(value.platform) ? value.platform : "16:9",
      seconds: Number.isFinite(value.seconds) ? Math.min(120, Math.max(5, value.seconds)) : 15,
      budgetCny: Number.isFinite(value.budgetCny) && value.budgetCny >= 0 ? Math.min(1_000_000_000, value.budgetCny) : null,
      material: typeof value.material === "string" ? value.material : "",
      plans, planIndex,
    };
  } catch { return null; }
}

/**
 * Goal → audience → platform → shootable plan. The plan is data: every scene
 * is editable before composing. The approved structure goes to the model
 * composer without flattening its timing and scene kinds into Markdown.
 * Drafts survive a refresh; submissions carry a requestId so a dropped
 * connection retries the same model call instead of paying twice.
 */
export function CreationWizard({ onCompose, disabled = false }: { onCompose(source: string, options: { theme: string; aspect: string }, plan: VideoPlan, requestId: string): void | Promise<void>; disabled?: boolean }) {
  const [draft] = useState<WizardDraft | null>(() => readDraft());
  const [goal, setGoal] = useState(draft?.goal ?? "");
  const [audience, setAudience] = useState(draft?.audience ?? "");
  const [platform, setPlatform] = useState(draft?.platform ?? "16:9");
  const [seconds, setSeconds] = useState(draft?.seconds ?? 15);
  const [budgetCny, setBudgetCny] = useState<number | "">(draft?.budgetCny ?? "");
  const [material, setMaterial] = useState(draft?.material ?? "");
  const [plans, setPlans] = useState<VideoPlan[]>(draft?.plans ?? []);
  const [planIndex, setPlanIndex] = useState(draft?.planIndex ?? 0);
  // CREATE-03: dropping a plan is undoable — the dropped variant is kept here
  // (not persisted) until another plan is dropped, then restored intact.
  const [discarded, setDiscarded] = useState<{ plan: VideoPlan; at: number } | null>(null);
  const plan: VideoPlan | null = plans[planIndex] ?? null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [draftNote, setDraftNote] = useState(draft ? "已恢复上次草稿" : "");
  const requestRef = useRef<{ signature: string; requestId: string } | null>(null);
  // The first effect run after a restore just re-writes the identical draft;
  // skip it so "已恢复上次草稿" stays visible until the user edits something.
  const skipInitialSave = useRef(Boolean(draft?.plans.length ?? draft?.goal));

  useEffect(() => {
    if (skipInitialSave.current) { skipInitialSave.current = false; return; }
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ goal, audience, platform, seconds, budgetCny: budgetCny === "" ? null : budgetCny, material, plans, planIndex })); setDraftNote("草稿已自动保存"); }
    catch { setDraftNote("本地存储不可用，草稿仅本次浏览保留"); }
  }, [goal, audience, platform, seconds, material, plans, planIndex]);

  const generate = async () => {
    if (!goal.trim() || busy) { if (!goal.trim()) setError("先写一句目标。"); return; }
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/plan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ goal, audience, platform, seconds, budgetCny: budgetCny === "" ? undefined : budgetCny, material }), signal: AbortSignal.timeout(150_000) });
      const data = await response.json();
      if (!response.ok) throw new Error(typeof data?.error === "string" ? data.error : "规划失败");
      const next = VideoPlan.parse(data.plan);
      const withTotals = { ...next, totalSeconds: next.scenes.reduce((sum, scene) => sum + scene.seconds, 0) };
      setPlans(current => [...current, withTotals].slice(-5));
      setPlanIndex(Math.min(plans.length, 4));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "规划失败"); }
    finally { setBusy(false); }
  };
  const updatePlan = (update: (plan: VideoPlan) => VideoPlan) => setPlans(current => current.map((candidate, index) => index === planIndex ? update(candidate) : candidate));
  const patchScene = (index: number, patch: Partial<VideoPlan["scenes"][number]>) => {
    if (!plan || busy || disabled) return;
    updatePlan(current => {
      const scenes = current.scenes.map((scene, at) => at === index ? { ...scene, ...patch } : scene);
      return { ...current, scenes, totalSeconds: scenes.reduce((sum, scene) => sum + scene.seconds, 0) };
    });
  };
  const editScenes = (index: number, action: "up" | "down" | "duplicate" | "remove") => {
    if (!plan || busy || disabled) return;
    updatePlan(current => {
      const scenes = [...current.scenes];
      if (action === "remove" && scenes.length > 1) scenes.splice(index, 1);
      if (action === "duplicate" && scenes.length < 30) scenes.splice(index + 1, 0, { ...scenes[index]! });
      const target = index + (action === "up" ? -1 : 1);
      if ((action === "up" || action === "down") && target >= 0 && target < scenes.length) [scenes[index], scenes[target]] = [scenes[target]!, scenes[index]!];
      return { ...current, scenes, totalSeconds: scenes.reduce((sum, scene) => sum + scene.seconds, 0) };
    });
  };
  const compose = async () => {
    if (!plan || busy || disabled) return;
    const imageShot = plan.scenes.findIndex(scene => scene.kind === "image");
    if (imageShot >= 0) { setError(`镜头 ${imageShot + 1} 需要先绑定真实素材：请把类型换成其他镜头并重新制作，生成工程后再在编辑器里添加图片。`); return; }
    setBusy(true); setError("");
    try {
      const approved = VideoPlan.parse(plan);
      const signature = JSON.stringify(approved);
      if (requestRef.current?.signature !== signature) requestRef.current = { signature, requestId: crypto.randomUUID() };
      await onCompose(planToSource(approved), { theme: approved.theme, aspect: approved.platform }, approved, requestRef.current.requestId);
    } catch (cause) {
      const offline = cause instanceof TypeError;
      setError(offline
        ? "连接中断，制作任务可能仍在服务器上运行；再次点击会复用同一任务，不会重复调用模型。"
        : cause instanceof Error ? cause.message : "制作失败，分镜已保留，可重试。");
    }
    finally { setBusy(false); }
  };

  return <section aria-label="创作向导" className="cw">
    <div className="cw-grid">
      <label className="cw-field">这条视频要达成什么<textarea aria-label="创作目标" rows={2} maxLength={500} className="g-field" value={goal} onChange={event => setGoal(event.target.value)} placeholder="例：给咖啡店开业做一条 15 秒宣传，主打手冲和到店礼" /></label>
      <label className="cw-field">给谁看<input aria-label="目标受众" maxLength={200} className="g-field" value={audience} onChange={event => setAudience(event.target.value)} placeholder="例：周边居民、上班族" /></label>
      <label className="cw-field">画幅<select aria-label="目标画幅" className="g-field" value={platform} onChange={event => setPlatform(event.target.value)}><option value="16:9">横屏 16:9</option><option value="9:16">竖屏 9:16</option><option value="1:1">方形 1:1</option></select></label>
      <label className="cw-field cw-field--tight">秒数<input aria-label="目标时长" type="number" min={5} max={120} className="g-field" value={seconds} onChange={event => setSeconds(Number(event.target.value))} /></label>
      <label className="cw-field cw-field--wide">预算（元，可选）<input aria-label="制作预算" type="number" min={0} max={1000000000} step="any" className="g-field" value={budgetCny} onChange={event => setBudgetCny(event.target.value === "" ? "" : Number(event.target.value))} placeholder="不填=低成本优先" /></label>
    </div>
    <label className="cw-field">素材要点（可选）<textarea aria-label="素材要点" rows={2} maxLength={3000} className="g-field" value={material} onChange={event => setMaterial(event.target.value)} placeholder="时间、地点、卖点、数字；没有就留空，不会编造。" /></label>
    <div className="cw-actions">
      <button type="button" className={plan ? "g-btn" : "g-btn g-btn--primary"} disabled={busy || disabled} onClick={() => void generate()}>{busy ? "正在规划…" : "生成计划"}</button>
      <small className="cw-note">需要已配置的文本模型；再次生成会追加一个方案，可来回比较，最多保留 5 个。</small>
      {draftNote && <small className="cw-note">{draftNote}</small>}
      {error && <span role="alert" className="cw-error">{error}</span>}
    </div>
    {plan && <div className="cw-plan">
      <div className="cw-plan-head">
        {plans.length > 1 && <span className="cw-compare" role="group" aria-label="方案比较">
          <button type="button" className="g-btn g-btn--sm g-btn--icon" aria-label="上一个方案" disabled={busy || disabled || planIndex === 0} onClick={() => setPlanIndex(value => value - 1)}>‹</button>
          <small className="cw-index" aria-live="polite">方案 {planIndex + 1}/{plans.length}</small>
          <button type="button" className="g-btn g-btn--sm g-btn--icon" aria-label="下一个方案" disabled={busy || disabled || planIndex === plans.length - 1} onClick={() => setPlanIndex(value => value + 1)}>›</button>
          <button type="button" className="g-btn g-btn--sm g-btn--quiet" aria-label="删除当前方案" disabled={busy || disabled} onClick={() => { setDiscarded({ plan, at: planIndex }); setPlans(current => current.filter((_, at) => at !== planIndex)); setPlanIndex(value => Math.max(0, Math.min(value, plans.length - 2))); }}>丢弃</button>
        </span>}
        {discarded && <button type="button" className="g-btn g-btn--sm g-btn--quiet" aria-label="撤销丢弃方案" disabled={busy || disabled} onClick={() => {
          setPlans(current => { const next = [...current]; next.splice(Math.min(discarded.at, current.length), 0, discarded.plan); return next; });
          setPlanIndex(discarded.at); setDiscarded(null);
        }}>撤销丢弃</button>}
        <strong className="cw-plan-title">{plan.title}</strong>
        <small className="cw-meta">{plan.hook} · {plan.audience} · {plan.totalSeconds}s · {plan.platform} · {plan.theme}</small>
      </div>
      <label className="cw-field cw-field--inline">视觉风格 <select aria-label="计划视觉风格" className="g-field" disabled={busy || disabled} value={plan.theme} onChange={event => updatePlan(current => ({ ...current, theme: event.target.value }))}>{THEME_IDS.map(theme => <option key={theme} value={theme}>{theme}</option>)}</select></label>
      <StoryboardPreview plan={plan} />
      <ol className="cw-scenes">
        {plan.scenes.map((scene, index) => <li key={index} className="cw-scene">
          <div className="cw-scene-head">
            <span className="cw-index">镜头 {index + 1}</span>
            <select aria-label={`镜头 ${index + 1} 类型`} value={scene.kind} className="g-field cw-kind" onChange={event => patchScene(index, { kind: event.target.value as typeof scene.kind })}>{([['title', '标题'], ['bullets', '要点'], ['definition', '定义'], ['comparison', '对比'], ['quote', '引语'], ['chart', '图表'], ['diagram', '流程']] as const).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}{scene.kind === "image" && <option value="image">图片（需素材）</option>}</select>
            <input aria-label={`镜头 ${index + 1} 目标`} value={scene.goal} maxLength={200} onChange={event => patchScene(index, { goal: event.target.value })} className="g-field cw-goal" />
            <label className="cw-field cw-field--inline">{scene.seconds}s<input aria-label={`镜头 ${index + 1} 时长`} type="number" min={1} max={120} value={scene.seconds} onChange={event => patchScene(index, { seconds: Math.max(1, Math.min(120, Number(event.target.value) || 1)) })} className="g-field cw-seconds" /></label>
          </div>
          <label className="cw-field">口播<textarea aria-label={`镜头 ${index + 1} 口播`} rows={2} maxLength={400} value={scene.narration} onChange={event => patchScene(index, { narration: event.target.value })} className="g-field" /></label>
          <label className="cw-field">画面<textarea aria-label={`镜头 ${index + 1} 画面`} rows={2} maxLength={300} value={scene.visual} onChange={event => patchScene(index, { visual: event.target.value })} className="g-field" /></label>
          <div role="group" aria-label={`镜头 ${index + 1} 视觉规划`} className="cw-actions">
            {([["布局", "layout", LAYOUT_BADGES], ["关系", "relation", RELATION_BADGES], ["运镜", "motion", MOTION_BADGES]] as const).map(([label, key, badges]) => (
              <label key={key} className="cw-field cw-field--inline">{label}
                <select aria-label={`镜头 ${index + 1} ${label}`} className="g-field cw-visual" value={scene[key] ?? ""}
                  onChange={event => patchScene(index, { [key]: event.target.value || undefined } as Partial<VideoPlan["scenes"][number]>)}>
                  <option value="">自动</option>
                  {Object.entries(badges).filter(([value]) => value !== "none").map(([value, text]) => <option key={value} value={value}>{text}</option>)}
                </select>
              </label>
            ))}
          </div>
          <div className="cw-actions">
            <button type="button" className="g-btn g-btn--sm" aria-label={`上移镜头 ${index + 1}`} disabled={busy || disabled || index === 0} onClick={() => editScenes(index, "up")}>上移</button>
            <button type="button" className="g-btn g-btn--sm" aria-label={`下移镜头 ${index + 1}`} disabled={busy || disabled || index === plan.scenes.length - 1} onClick={() => editScenes(index, "down")}>下移</button>
            <button type="button" className="g-btn g-btn--sm" aria-label={`复制镜头 ${index + 1}`} disabled={busy || disabled || plan.scenes.length >= 30} onClick={() => editScenes(index, "duplicate")}>复制</button>
            <button type="button" className="g-btn g-btn--sm g-btn--quiet" aria-label={`删除镜头 ${index + 1}`} disabled={busy || disabled || plan.scenes.length === 1} onClick={() => editScenes(index, "remove")}>删除</button>
          </div>
        </li>)}
      </ol>
      <button type="button" className="g-btn g-btn--primary cw-submit" disabled={busy || disabled} onClick={() => void compose()}>{busy ? "正在制作工程…" : "用这个计划开始制作"}</button>
    </div>}
  </section>;
}
