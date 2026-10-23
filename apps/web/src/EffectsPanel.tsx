import { useEffect, useState, type CSSProperties } from "react";
import { LOOK_PRESETS, parseProject, type SceneEffect, type SceneScriptProject } from "@glintai/scenescript";

export interface EffectsPanelProps {
  project: SceneScriptProject;
  sceneId: string;
  onChange(project: SceneScriptProject): void;
}

const MAX_EFFECTS = 16;
const settings: Record<SceneEffect["kind"], { label: string; min: number; max: number; step: number; initial: number }> = {
  brightness: { label: "亮度", min: 0, max: 3, step: 0.01, initial: 1 },
  contrast: { label: "对比度", min: 0, max: 3, step: 0.01, initial: 1 },
  saturate: { label: "饱和度", min: 0, max: 3, step: 0.01, initial: 1 },
  grayscale: { label: "黑白", min: 0, max: 1, step: 0.01, initial: 1 },
  sepia: { label: "复古", min: 0, max: 1, step: 0.01, initial: 0.65 },
  hue: { label: "色相（度）", min: -180, max: 180, step: 1, initial: 0 },
  blur: { label: "模糊（像素）", min: 0, max: 30, step: 0.1, initial: 0 },
};
const kinds = Object.keys(settings) as SceneEffect["kind"][];
const presets: Record<string, Array<Pick<SceneEffect, "kind" | "value">>> = {
  原色: [], 黑白: [{ kind: "grayscale", value: 1 }],
  复古: [{ kind: "sepia", value: 0.65 }, { kind: "contrast", value: 1.1 }],
  清透: [{ kind: "brightness", value: 1.08 }, { kind: "saturate", value: 1.12 }],
  ...Object.fromEntries(LOOK_PRESETS.map(look => [look.label, look.effects.map(effect => ({ ...effect }))])),
};
const row: CSSProperties = { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 };
const control: CSSProperties = { background: "var(--surface-2, inherit)", color: "inherit", font: "inherit",
  border: "1px solid #2b2b31", borderRadius: 8, padding: "8px 12px", minWidth: 0 };
const buttonStyle = (disabled = false): CSSProperties => ({ ...control,
  cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1 });

/** Local, whole-frame effects only; static controls never rewrite animated parameters. */
export function EffectsPanel({ project, sceneId, onChange }: EffectsPanelProps) {
  const scene = project.scenes.find(item => item.id === sceneId);
  const effects = scene?.effects ?? [];
  const locked = scene?.locked === true;
  const [scope, setScope] = useState<"current" | "all">("current");
  const [strength, setStrength] = useState(100);
  const targets = scope === "all" ? project.scenes : scene ? [scene] : [];
  const presetBlock = targets.some(item => item.locked)
    ? "应用范围内有已锁定场景，预设未应用；请先解锁或改为当前场景。"
    : targets.some(item => item.effects?.some(effect => effect.keyframes?.length))
      ? "应用范围内有效果含关键帧，预设替换已停用，避免丢失动画；请先显式删除含关键帧的效果或调整应用范围。" : null;
  const [kind, setKind] = useState<SceneEffect["kind"]>("brightness");
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null);
  useEffect(() => { setFeedback(null); }, [sceneId]);

  const update = (transform: (current: SceneEffect[]) => SceneEffect[], success: string) => {
    if (!scene || locked) return;
    let next: SceneScriptProject;
    try {
      const stack = transform(effects);
      if (stack.length > MAX_EFFECTS) throw new Error("effect limit");
      next = parseProject({ ...project, scenes: project.scenes.map(item =>
        item.id === scene.id ? { ...item, effects: stack } : item) });
    } catch {
      setFeedback({ error: true, text: "画面风格未保存。请检查参数范围和项目数据后重试（最多 16 个效果）。" });
      return;
    }
    onChange(next);
    setFeedback({ error: false, text: success });
  };
  const newEffects = (values: Array<Pick<SceneEffect, "kind" | "value">>,
    used = new Set(project.scenes.flatMap(item => item.effects?.map(effect => effect.id) ?? []))): SceneEffect[] => {
    return values.map(value => {
      const id = `effect-${crypto.randomUUID()}`;
      if (used.has(id)) throw new Error("duplicate effect id");
      used.add(id);
      return { ...value, id };
    });
  };
  const applyPreset = (name: string, values: Array<Pick<SceneEffect, "kind" | "value">>) => {
    if (!scene || presetBlock) return;
    let next: SceneScriptProject;
    try {
      const used = new Set(project.scenes.flatMap(item => item.effects?.map(effect => effect.id) ?? []));
      const weighted = strength === 0 ? [] : values.map(effect => {
        const identity = ["brightness", "contrast", "saturate"].includes(effect.kind) ? 1 : 0;
        return { ...effect, value: identity + (effect.value - identity) * strength / 100 };
      });
      next = parseProject({ ...project, scenes: project.scenes.map(item =>
        scope === "all" || item.id === scene.id ? { ...item, effects: newEffects(weighted, used) } : item) });
    } catch {
      setFeedback({ error: true, text: "画面风格未保存。请检查参数范围和项目数据后重试（最多 16 个效果）。" });
      return;
    }
    onChange(next);
    setFeedback({ error: false, text: `${name === "原色" ? "已清空全部效果，恢复原色。" : `已应用${name}预设。`}${scope === "all" ? "已应用到全部场景。" : ""}` });
  };
  const changeValue = (id: string, raw: string) => {
    const effect = effects.find(item => item.id === id);
    if (!effect || effect.keyframes?.length || locked) return;
    const value = Number(raw);
    const { min, max } = settings[effect.kind];
    if (!raw.trim() || !Number.isFinite(value) || value < min || value > max) {
      setFeedback({ error: true, text: `请输入 ${min} 至 ${max} 之间的有效数值。项目未修改。` });
      return;
    }
    update(current => current.map(item => item.id === id ? { ...item, value } : item), "效果参数已更新。");
  };
  const move = (index: number, delta: number) => update(current => {
    const next = [...current];
    const target = index + delta;
    if (target < 0 || target >= next.length) return next;
    [next[index], next[target]] = [next[target]!, next[index]!];
    return next;
  }, "效果顺序已更新。");

  return <section aria-label="画面风格" style={{ display: "grid", gap: 12, minWidth: 0, padding: 12,
    border: "1px solid #2b2b31", borderRadius: 10, fontVariantNumeric: "tabular-nums" }}>
    <strong>画面风格</strong>
    <small>效果按列表顺序作用于整个场景画面，包含字幕和文字。不支持局部蒙版或 LUT。</small>
    {!scene ? <p role="status">未找到当前场景，请重新选择场景后调整画面风格。</p> : <>
      {locked && <p style={{ margin: 0 }}>当前场景已锁定，请先解锁再调整画面风格。</p>}
      <fieldset disabled={locked} title={locked ? "请先解锁当前场景" : undefined}
        style={{ display: "grid", gap: 12, border: 0, margin: 0, padding: 0, minWidth: 0, opacity: locked ? 0.5 : 1 }}>
        <legend>本地预设</legend>
        <label>应用范围 <select aria-label="应用范围" style={control} value={scope}
          onChange={event => { setScope(event.target.value as "current" | "all"); setFeedback(null); }}>
          <option value="current">当前场景</option><option value="all">全部场景</option>
        </select></label>
        <label>预设强度 {strength}% <input aria-label="预设强度" type="range" min={0} max={100} step={1} value={strength} onChange={event => setStrength(Number(event.target.value))} /></label>
        <small>先调强度，再选预设应用；0% 恢复原画。应用范围仅用于预设，单项调整只改当前场景。预设会替换范围内的效果列表；原色会清空全部效果。</small>
        <div style={row}>{Object.entries(presets).map(([name, values]) => <button key={name} type="button"
          disabled={Boolean(presetBlock)} style={buttonStyle(Boolean(presetBlock) || locked)}
          title={presetBlock ?? undefined} onClick={() => applyPreset(name, values)}>
          {name}
        </button>)}</div>
        <small>“克制印色、柔和人像、低彩纪实、简洁黑白”为 Glint 原创通用配方（Apache-2.0），不是任何相机品牌的官方模拟；仅适用于已显示为 sRGB 的画面。</small>
        {presetBlock && <small>{presetBlock}</small>}
        <details><summary style={{ cursor: "pointer" }}>精细调整（可选）</summary>
        <div style={row}>
          <label>添加效果 <select aria-label="效果类型" value={kind} style={control}
            onChange={event => setKind(event.target.value as SceneEffect["kind"])}>
            {kinds.map(value => <option key={value} value={value}>{settings[value].label}</option>)}
          </select></label>
          <button type="button" disabled={effects.length >= MAX_EFFECTS} style={buttonStyle(locked || effects.length >= MAX_EFFECTS)}
            title={effects.length >= MAX_EFFECTS ? "最多 16 个效果，请先删除部分效果" : undefined}
            onClick={() => update(current => [...current, ...newEffects([{ kind, value: settings[kind].initial }])], "已添加效果。")}>添加效果</button>
          <span>{effects.length} / {MAX_EFFECTS}</span>
        </div>
        {effects.length >= MAX_EFFECTS && <small>最多 16 个效果，请先删除部分效果再添加。</small>}
        {!effects.length ? <p style={{ margin: 0 }}>当前为原色。选择预设或添加效果开始调整。</p> : <ol style={{ display: "grid", gap: 12, margin: 0, paddingLeft: 24 }}>
          {effects.map((effect, index) => {
            const config = settings[effect.kind];
            const hasKeys = Boolean(effect.keyframes?.length);
            const label = `${index + 1} · ${config.label}`;
            return <li key={effect.id} style={{ minWidth: 0 }}>
              <div style={{ display: "grid", gap: 8 }}>
                <div style={row}><strong>{label}</strong>
                  <label style={row}><input type="checkbox" aria-label={`启用 ${label}`} checked={effect.enabled !== false}
                    onChange={event => update(current => current.map(item => item.id === effect.id ? { ...item, enabled: event.target.checked } : item), "效果启用状态已更新。")} />启用</label>
                  <button type="button" aria-label={`上移 ${label}`} disabled={index === 0} style={buttonStyle(locked || index === 0)}
                    onClick={() => move(index, -1)}>上移</button>
                  <button type="button" aria-label={`下移 ${label}`} disabled={index === effects.length - 1} style={buttonStyle(locked || index === effects.length - 1)}
                    onClick={() => move(index, 1)}>下移</button>
                  <button type="button" aria-label={`删除 ${label}`} style={buttonStyle(locked)}
                    onClick={() => update(current => current.filter(item => item.id !== effect.id), "已删除效果。")}>删除</button>
                </div>
                <div style={row}>
                  <input type="range" aria-label={`${label} 滑块`} min={config.min} max={config.max} step={config.step}
                    disabled={hasKeys} value={effect.value} title={hasKeys ? "此效果含关键帧，静态参数不会覆盖动画" : undefined}
                    style={{ flex: "1 1 120px", minWidth: 0, accentColor: "var(--accent, currentColor)", opacity: hasKeys ? 0.5 : 1 }}
                    onChange={event => changeValue(effect.id, event.target.value)} />
                  <input type="number" aria-label={`${label} 数值`} min={config.min} max={config.max} step={config.step}
                    disabled={hasKeys} value={effect.value} title={hasKeys ? "此效果含关键帧，静态参数不会覆盖动画" : undefined}
                    style={{ ...control, width: 96, opacity: hasKeys ? 0.5 : 1 }}
                    onChange={event => changeValue(effect.id, event.target.value)} />
                  <small>{config.min} ～ {config.max}</small>
                </div>
                {hasKeys && <small>此效果含关键帧，静态参数不会覆盖动画</small>}
              </div>
            </li>;
          })}
        </ol>}
        </details>
      </fieldset>
    </>}
    {scene && feedback && <p role={feedback.error ? "alert" : "status"} style={{ margin: 0 }}>{feedback.text}</p>}
  </section>;
}
