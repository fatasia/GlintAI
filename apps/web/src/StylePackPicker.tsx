import { lazy, Suspense, useRef, useState, type CSSProperties } from "react";
import { AESTHETIC_FONTS, STYLE_PACKS, type ThemeName } from "@glintai/design-tokens";
import { suggestStylePacks, type Rgb } from "./style-suggest";
import { parseProject, type SceneScriptProject } from "@glintai/scenescript";
import { captureStyleTokens, readStyleSnapshot } from "./style-snapshot";

const StylePackSample = lazy(() => import("./StylePackSample"));
const StyleCatalog = lazy(() => import("./StyleCatalog"));

const button: CSSProperties = { color: "inherit", background: "var(--ink-3)", border: "1px solid var(--line-2)", borderRadius: 8, padding: "8px 12px", font: "inherit", cursor: "pointer" };
const field: CSSProperties = { boxSizing: "border-box", width: "100%", minWidth: 0, padding: 10, borderRadius: 8, border: "1px solid var(--line-2)", background: "var(--ink-2)", color: "inherit", font: "inherit" };

/** Browse without changing the draft; applying is delegated to the owning editor. */
export function StylePreviewChooser({ current, onApply }: { current: string; onApply(theme: ThemeName): void }) {
  const [selected, setSelected] = useState<ThemeName>(() => STYLE_PACKS.find(pack => pack.name === current)?.name ?? STYLE_PACKS[0]!.name);
  const pack = STYLE_PACKS.find(item => item.name === selected)!;
  return <section aria-label="风格样片目录" style={{ display: "grid", gap: 10, minWidth: 0 }}>
    <small>选择后先预览固定无声示例；只有点击使用才会更改风格，不会生成视频。</small>
    <label>预览风格 <select aria-label="预览风格" value={selected} onChange={event => setSelected(event.target.value as ThemeName)} style={field}>
      {STYLE_PACKS.map(item => <option key={item.name} value={item.name}>{item.label}</option>)}
    </select></label>
    <strong>{pack.label} · <small>{pack.summary}</small></strong>
    <div aria-label="风格目录样片" style={{ width: "100%", maxWidth: 560, minWidth: 0 }}>
      <Suspense fallback={<p role="status">正在加载样片…</p>}><StylePackSample theme={selected} /></Suspense>
    </div>
    <div><button type="button" style={button} disabled={selected === current} onClick={() => onApply(selected)}>{selected === current ? "当前已使用此风格" : `使用「${pack.label}」`}</button></div>
  </section>;
}

/** Project-level style: colour plus type, composition, motion, pacing and sound. */
export function StylePackPicker({ project, onChange, analyze = analyzeReferenceImage }: { project: SceneScriptProject; onChange(project: SceneScriptProject): void; analyze?(file: File): Promise<Rgb[]> }) {
  const latestProject = useRef(project);
  latestProject.current = project;
  const snapshot = readStyleSnapshot(project.theme);
  const unrecognizedSnapshot = Boolean(project.theme && typeof project.theme === "object" && Object.hasOwn(project.theme, "glintStyleSnapshot") && !snapshot);
  const current = snapshot?.name ?? (typeof project.theme === "string" && STYLE_PACKS.some(pack => pack.name === project.theme) ? project.theme as ThemeName : "");
  const [selected, setSelected] = useState<ThemeName>(current || STYLE_PACKS[0]!.name);
  const [showSample, setShowSample] = useState(false);
  const [applying, setApplying] = useState(false);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const [suggestions, setSuggestions] = useState<ReturnType<typeof suggestStylePacks>>([]);
  const [reference, setReference] = useState("");
  const [refError, setRefError] = useState("");
  const file = useRef<HTMLInputElement | null>(null);
  const referenceRequest = useRef(0);
  const pack = STYLE_PACKS.find(item => item.name === selected)!;
  const { typography, composition, motion, pacing, sound } = pack.aesthetic;
  const font = (key: keyof typeof AESTHETIC_FONTS) => {
    const value = AESTHETIC_FONTS[key];
    return `${value.name} ${value.version} · ${value.license}`;
  };
  const apply = async () => {
    if (applying) return;
    if (project.theme && typeof project.theme === "object" && !window.confirm("应用新风格会替换工程中保存的风格参数或快照，原快照将先保存到主题版本。是否继续？")) return;
    setApplying(true);
    setFeedback({ error: false, text: "正在保存原主题版本…" });
    try {
      const next = { ...project, theme: selected };
      parseProject(next);
      const { archiveCurrentStyle } = await import("./StyleCatalog");
      await archiveCurrentStyle(project);
      if (latestProject.current !== project) throw new Error("工程已变化");
      onChange(next);
      setFeedback({ error: false, text: `已应用「${pack.label}」，原主题已保存，可撤销。` });
    } catch {
      setFeedback({ error: true, text: "风格未应用：无法保存原主题版本或工程数据无效，请检查服务与存储后重试。" });
    } finally { setApplying(false); }
  };
  const freeze = () => {
    if (!current || typeof project.theme !== "string") return;
    try {
      const next = { ...project, theme: captureStyleTokens(current) };
      parseProject(next);
      onChange(next);
      setFeedback({ error: false, text: "已保存风格参数快照，可撤销。" });
    } catch { setFeedback({ error: true, text: "未能保存风格参数，请先修复工程。" }); }
  };
  const readReference = async (selected: File | undefined) => {
    const requestId = ++referenceRequest.current;
    setSuggestions([]);
    setReference("");
    if (file.current) file.current.value = "";
    if (!selected || !selected.type.startsWith("image/")) { setRefError("请选择一张图片作为参考。"); return; }
    setRefError("");
    try {
      const pixels = await analyze(selected);
      if (requestId !== referenceRequest.current) return;
      setSuggestions(suggestStylePacks(pixels));
      setReference(selected.name);
    } catch (error) {
      if (requestId === referenceRequest.current) setRefError(error instanceof Error ? error.message : "无法读取这张参考图。");
    }
  };
  return <details aria-label="风格包" onToggle={event => { if (!event.currentTarget.open) setShowSample(false); }}>
    <summary style={{ cursor: "pointer" }}>风格包 · 字体 / 构图 / 节奏 / 声音{current ? `（当前：${STYLE_PACKS.find(item => item.name === current)!.label}）` : "（当前：自定义主题）"}</summary>
    <div style={{ display: "grid", gap: 12, paddingTop: 12, minWidth: 0 }}>
      <section aria-label="参考图风格建议" style={{ display: "grid", gap: 8, padding: 10, border: "1px dashed var(--line-2)", borderRadius: 10 }}>
        <strong>从参考图建议风格</strong>
        <small>本地取色启发式：比较明暗、饱和度与色温，不识别物体或人名，也不声称复刻某位摄影师。</small>
        <input ref={file} aria-label="选择参考图" type="file" accept="image/png,image/jpeg,image/webp" onChange={event => void readReference(event.target.files?.[0])} />
        {reference && <small>参考：{reference}</small>}
        {suggestions.length > 0 && <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {suggestions.map(item => <button type="button" key={item.name} style={button} onClick={() => { setSelected(item.name); setFeedback(null); }}>用「{item.label}」<small style={{ display: "block" }}>{item.reason}</small></button>)}
        </div>}
        {refError && <p role="alert" style={{ margin: 0 }}>{refError}</p>}
      </section>
      <div role="group" aria-label="可选风格包" style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 4 }}>
        {STYLE_PACKS.map(item => <button type="button" key={item.name} aria-pressed={item.name === selected} style={{ ...button, minWidth: 132, textAlign: "left", borderColor: item.name === selected ? "#7c8cff" : undefined }}
          onClick={() => { setSelected(item.name); setFeedback(null); }}>
          <strong style={{ display: "block" }}>{item.label}</strong>
          <small>{item.category} · {item.aesthetic.composition.density}</small>
          {item.name === current && <small style={{ display: "block" }}>当前使用</small>}
        </button>)}
      </div>
      <section aria-label="风格详情" style={{ display: "grid", gap: 8, padding: 12, border: "1px solid var(--line-2)", borderRadius: 10, minWidth: 0 }}>
        <strong>{pack.label} <small>{pack.summary}</small></strong>
        <div><button type="button" aria-expanded={showSample} style={button} onClick={() => setShowSample(value => !value)}>{showSample ? "关闭样片" : "查看风格样片"}</button></div>
        {showSample && <div aria-label="风格样片" style={{ width: "100%", maxWidth: 560, minWidth: 0 }}>
          <Suspense fallback={<p role="status">正在加载样片…</p>}><StylePackSample theme={selected} /></Suspense>
          <small>固定示例，使用当前目录主题渲染；无音频，不修改工程。</small>
        </div>}
        <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", margin: 0 }}>
          <dt>字体</dt><dd style={{ margin: 0, overflowWrap: "anywhere" }}>标题 {font(typography.display)}；正文 {font(typography.body)}；标注 {font(typography.mono)}<br /><small>{typography.notes}</small></dd>
          <dt>构图</dt><dd style={{ margin: 0 }}>{composition.grid}；安全区 {composition.safeArea}；密度 {composition.density}<br /><small>{composition.notes}</small></dd>
          <dt>动效</dt><dd style={{ margin: 0 }}>{motion.easing}，入场 {motion.entranceMs}ms<br /><small>减弱动效：{motion.reducedMotion}</small></dd>
          <dt>节奏</dt><dd style={{ margin: 0 }}>{pacing.shotMs[0]}–{pacing.shotMs[1]}ms/镜，停留 {pacing.holdMs}ms<br /><small>{pacing.cutPattern}</small></dd>
          <dt>声音</dt><dd style={{ margin: 0 }}>{sound.mood}；{sound.targetLufs} LUFS；闪避 {sound.duckingDb}dB</dd>
        </dl>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <button type="button" aria-label={`应用风格 ${pack.label}`} style={{ ...button, opacity: selected === current ? 0.5 : 1 }} disabled={selected === current || applying} onClick={() => void apply()}>{selected === current ? "当前已是这个风格" : `应用「${pack.label}」`}</button>
          {current && typeof project.theme === "string" && <button type="button" style={button} onClick={freeze}>固定当前风格参数</button>}
          <small style={{ alignSelf: "center" }}>只改画面风格与节奏建议；不改旁白、素材和镜头顺序。字体只做引用，不打包字节。</small>
        </div>
        {feedback && <p role={feedback.error ? "alert" : "status"} style={{ margin: 0 }}>{feedback.text}</p>}
      </section>
      <Suspense fallback={<p role="status">正在加载样片目录…</p>}><StyleCatalog key={project.id} project={project} selected={selected} onChange={onChange} /></Suspense>
      <small>{snapshot ? `风格参数快照 v${snapshot.version}${snapshot.modified ? "（已修改）" : ""}；字体文件和渲染器不固定。` : unrecognizedSnapshot ? "无法识别的风格快照版本或格式已保留；应用新风格将替换快照。" : typeof project.theme === "string" && !current ? `未知风格「${project.theme}」已保留；应用新风格将替换它。` : "主题名称会随目录更新；可固定当前风格参数。"} 换风格不会重新生成视频。</small>
      <style>{`@media (max-width: 600px) { [aria-label="可选风格包"] { flex-wrap: nowrap; } }`}</style>
    </div>
  </details>;
}
/** 48×48 average-colour sampling; a browser-only helper, injectable for tests. */
export async function analyzeReferenceImage(file: File): Promise<Rgb[]> {
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("这张图片无法解码，请换一张 PNG/JPEG/WebP。"));
      element.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = 48; canvas.height = 48;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("当前浏览器不支持画布取色。");
    context.drawImage(image, 0, 0, 48, 48);
    const data = context.getImageData(0, 0, 48, 48).data, pixels: Rgb[] = [];
    for (let index = 0; index < data.length; index += 4) {
      if (data[index + 3]! < 16) continue;
      pixels.push([data[index]!, data[index + 1]!, data[index + 2]!]);
    }
    return pixels;
  } finally { URL.revokeObjectURL(url); }
}