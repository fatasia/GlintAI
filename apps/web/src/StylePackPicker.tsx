import { useRef, useState, type CSSProperties } from "react";
import { AESTHETIC_FONTS, STYLE_PACKS, type ThemeName } from "@glintai/design-tokens";
import { suggestStylePacks, type Rgb } from "./style-suggest";
import { parseProject, type SceneScriptProject } from "@glintai/scenescript";

const button: CSSProperties = { color: "inherit", background: "#1c1c21", border: "1px solid #2b2b31", borderRadius: 8, padding: "8px 12px", font: "inherit", cursor: "pointer" };
const field: CSSProperties = { boxSizing: "border-box", width: "100%", minWidth: 0, padding: 10, borderRadius: 8, border: "1px solid #2b2b31", background: "#151518", color: "inherit", font: "inherit" };

/** Project-level style: colour plus type, composition, motion, pacing and sound. */
export function StylePackPicker({ project, onChange, analyze = analyzeReferenceImage }: { project: SceneScriptProject; onChange(project: SceneScriptProject): void; analyze?(file: File): Promise<Rgb[]> }) {
  const current = typeof project.theme === "string" && STYLE_PACKS.some(pack => pack.name === project.theme) ? project.theme as ThemeName : "";
  const [selected, setSelected] = useState<ThemeName>(current || STYLE_PACKS[0]!.name);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const [suggestions, setSuggestions] = useState<ReturnType<typeof suggestStylePacks>>([]);
  const [reference, setReference] = useState("");
  const [refError, setRefError] = useState("");
  const file = useRef<HTMLInputElement | null>(null);
  const pack = STYLE_PACKS.find(item => item.name === selected)!;
  const { typography, composition, motion, pacing, sound } = pack.aesthetic;
  const font = (key: keyof typeof AESTHETIC_FONTS) => {
    const value = AESTHETIC_FONTS[key];
    return `${value.name} ${value.version} · ${value.license}`;
  };
  const apply = () => {
    try {
      const next = parseProject({ ...project, theme: selected });
      if (JSON.stringify(next.scenes) !== JSON.stringify(project.scenes)) throw new Error("风格不应改动镜头");
      onChange(next);
      setFeedback({ error: false, text: `已应用「${pack.label}」，可撤销。` });
    } catch {
      setFeedback({ error: true, text: "风格未应用：工程数据不完整，请先修复项目后重试。" });
    }
  };
  const readReference = async (selected: File | undefined) => {
    if (!selected || !selected.type.startsWith("image/")) { setRefError("请选择一张图片作为参考。"); return; }
    setRefError("");
    try {
      const pixels = await analyze(selected);
      setSuggestions(suggestStylePacks(pixels));
      setReference(selected.name);
    } catch (error) { setSuggestions([]); setRefError(error instanceof Error ? error.message : "无法读取这张参考图。"); }
    finally { if (file.current) file.current.value = ""; }
  };
  return <details aria-label="风格包">
    <summary style={{ cursor: "pointer" }}>风格包 · 字体 / 构图 / 节奏 / 声音{current ? `（当前：${STYLE_PACKS.find(item => item.name === current)!.label}）` : "（当前：自定义主题）"}</summary>
    <div style={{ display: "grid", gap: 12, paddingTop: 12, minWidth: 0 }}>
      <section aria-label="参考图风格建议" style={{ display: "grid", gap: 8, padding: 10, border: "1px dashed #2b2b31", borderRadius: 10 }}>
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
      <section aria-label="风格详情" style={{ display: "grid", gap: 8, padding: 12, border: "1px solid #2b2b31", borderRadius: 10, minWidth: 0 }}>
        <strong>{pack.label} <small>{pack.summary}</small></strong>
        <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", margin: 0 }}>
          <dt>字体</dt><dd style={{ margin: 0, overflowWrap: "anywhere" }}>标题 {font(typography.display)}；正文 {font(typography.body)}；标注 {font(typography.mono)}<br /><small>{typography.notes}</small></dd>
          <dt>构图</dt><dd style={{ margin: 0 }}>{composition.grid}；安全区 {composition.safeArea}；密度 {composition.density}<br /><small>{composition.notes}</small></dd>
          <dt>动效</dt><dd style={{ margin: 0 }}>{motion.easing}，入场 {motion.entranceMs}ms<br /><small>减弱动效：{motion.reducedMotion}</small></dd>
          <dt>节奏</dt><dd style={{ margin: 0 }}>{pacing.shotMs[0]}–{pacing.shotMs[1]}ms/镜，停留 {pacing.holdMs}ms<br /><small>{pacing.cutPattern}</small></dd>
          <dt>声音</dt><dd style={{ margin: 0 }}>{sound.mood}；{sound.targetLufs} LUFS；闪避 {sound.duckingDb}dB</dd>
        </dl>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <button type="button" aria-label={`应用风格 ${pack.label}`} style={{ ...button, opacity: selected === current ? 0.5 : 1 }} disabled={selected === current} onClick={apply}>{selected === current ? "当前已是这个风格" : `应用「${pack.label}」`}</button>
          <small style={{ alignSelf: "center" }}>只改画面风格与节奏建议；不改旁白、素材和镜头顺序。字体只做引用，不打包字节。</small>
        </div>
        {feedback && <p role={feedback.error ? "alert" : "status"} style={{ margin: 0 }}>{feedback.text}</p>}
      </section>
      <small>换风格不会重新生成视频；已有效果、文字和素材保持不变。</small>
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