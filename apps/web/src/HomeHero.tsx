import { lazy, Suspense, useEffect, useState } from "react";
import { QuickVideo, type QuickVideoPreset } from "./QuickVideo";
import { QuickGif } from "./QuickGif";
import type { SavedProject } from "./project-history";

const QuickImage = lazy(() => import("./QuickImage").then(module => ({ default: module.QuickImage })));
type Capability = "video" | "image" | "gif";
const HEADLINES: Record<Capability, [string, string, string]> = {
  video: ["把一段资料", "变成能改的视频", "先出免费草稿，再逐镜改。改一镜，不用重算全片。"],
  image: ["把一句描述", "变成能用的图片", "文生图，按已配置的图片模型计费。"],
  gif: ["把一支作品", "变成能发的 GIF", "从已有作品导出，前 6 秒。"],
};

const SAMPLE = [
  { src: "/showcase/coffee-still.webp", title: "一杯咖啡的品牌片", meta: "15 秒 · 1080P", tag: "产品" },
  { src: "/showcase/entropy-second-law.png", title: "热力学第二定律", meta: "12 秒 · 讲解", tag: "讲解" },
  { src: "/showcase/uncertainty-intro.png", title: "Uncertainty Principle", meta: "18 秒 · 英文", tag: "讲解" },
  { src: "/showcase/entropy-intro.png", title: "熵与生命", meta: "10 秒 · 开场", tag: "讲解" },
];

const THEME_ACCENT: Record<string, string> = {
  "glint-dark": "#7c8cff",
  "glint-light": "#c7d2fe",
  "cream-editorial": "#c9a26b",
  "mint-clean": "#5eead4",
  "bold-poster": "#f97316",
};

export function HomeHero({ projects, onOpen, disabled = false, onEditProject, preset, onOpenReference }: {
  projects: SavedProject[];
  onOpen(project: SavedProject): void;
  disabled?: boolean;
  onEditProject?(project: unknown): void;
  preset?: QuickVideoPreset;
  onOpenReference?: () => void;
}) {
  const [kind, setKind] = useState<Capability>("video");
  useEffect(() => { if (preset) setKind("video"); }, [preset?.nonce]);
  const [headline, headlineAccent, blurb] = HEADLINES[kind];
  return <section aria-label="创作首页" style={{ width: "min(94vw, 1180px)", display: "grid", gap: 44 }}>
    <style>{`
      .glint-home-hero { display: grid; grid-template-columns: minmax(0, 1.12fr) minmax(0, .88fr); gap: 54px; align-items: center; }
      .glint-home-preview { position: relative; isolation: isolate; animation: glint-float 9s ease-in-out infinite; }
      .glint-composer-shell { position: relative; isolation: isolate; padding: 1px; border-radius: 19px; background: linear-gradient(120deg, rgba(124,140,255,.78), rgba(255,255,255,.08) 38%, rgba(192,132,252,.52), rgba(124,140,255,.78)); background-size: 200% 100%; animation: glint-border 10s linear infinite; }
      .glint-gallery-card img { transition: transform .55s cubic-bezier(.16,1,.3,1); }
      .glint-gallery-card:hover img { transform: scale(1.035); }
      .glint-home-hero textarea::placeholder { color: #8b8b95; }
      @keyframes glint-border { to { background-position: 200% 0; } }
      @keyframes glint-float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-7px); } }
      @media (max-width: 960px) { .glint-home-hero { grid-template-columns: 1fr; gap: 30px; } }
      @media (prefers-reduced-motion: reduce) { .glint-home-preview, .glint-composer-shell { animation: none; } .glint-gallery-card img { transition: none; } .glint-gallery-card:hover img { transform: none; } }
    `}</style>

    <div className="glint-home-hero">
      <div style={{ display: "grid", gap: 20, minWidth: 0 }}>
        <div role="tablist" aria-label="创作类型" style={{ display: "inline-flex", gap: 4, padding: 4, justifySelf: "start", width: "fit-content", borderRadius: 999, border: "1px solid #26262b", background: "rgba(16,16,19,.7)" }}>
          {([["video", "视频"], ["image", "图片"], ["gif", "GIF"]] as const).map(([value, label]) => <button key={value} type="button" role="tab" aria-selected={kind === value} onClick={() => setKind(value)} style={{ border: 0, borderRadius: 999, padding: "6px 16px", font: "inherit", fontSize: 12, cursor: "pointer", background: kind === value ? "#f4f4f5" : "transparent", color: kind === value ? "#09090b" : "#a1a1aa", fontWeight: kind === value ? 600 : 400 }}>{label}</button>)}
        </div>
        <h1 style={{ margin: 0, fontSize: "clamp(34px, 4.4vw, 58px)", lineHeight: 1.08, letterSpacing: "-0.035em", fontWeight: 700, color: "#f7f7f8" }}>{headline}<br />{headlineAccent}</h1>
        <p style={{ margin: 0, maxWidth: "40ch", color: "#a1a1aa", fontSize: 15, lineHeight: 1.7 }}>{blurb}</p>
        {kind === "video" && <div className="glint-composer-shell"><QuickVideo disabled={disabled} onEditProject={onEditProject} preset={preset} /></div>}
        {kind === "image" && <div className="glint-composer-shell"><Suspense fallback={<p role="status" style={{ margin: 0, padding: 22, color: "#8b8b95", fontSize: 13 }}>正在打开图片生成…</p>}><QuickImage disabled={disabled} /></Suspense></div>}
        {kind === "gif" && <QuickGif projects={projects} disabled={disabled} />}
        {kind === "video" && onOpenReference && <button type="button" onClick={onOpenReference} style={{ justifySelf: "start", border: 0, background: "transparent", color: "#8b8b95", font: "inherit", fontSize: 12, cursor: "pointer", padding: 0 }}>有参考片？从参考片仿拍 →</button>}
      </div>

      <aside className="glint-home-preview" aria-label="成片预览">
        <div style={{ position: "relative", aspectRatio: "16 / 9", borderRadius: 16, overflow: "hidden", border: "1px solid rgba(255,255,255,.10)", boxShadow: "0 44px 110px rgba(0,0,0,.6)" }}>
          <img src={SAMPLE[0]!.src} alt="示例成片静帧：一杯咖啡的品牌片" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
          <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, rgba(0,0,0,.05) 30%, rgba(0,0,0,.72) 100%)" }} />
          <span style={{ position: "absolute", left: 18, top: 16, padding: "5px 10px", borderRadius: 999, background: "rgba(9,9,11,.55)", border: "1px solid rgba(255,255,255,.16)", color: "#e4e4e7", fontSize: 11, backdropFilter: "blur(8px)" }}>示例静帧</span>
          <div style={{ position: "absolute", left: 18, right: 18, bottom: 14, display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 12 }}>
            <div style={{ display: "grid", gap: 2 }}><strong style={{ color: "#fafafa", fontSize: 15 }}>{SAMPLE[0]!.title}</strong><small style={{ color: "#a1a1aa", fontSize: 12 }}>{SAMPLE[0]!.meta}</small></div>
            <small style={{ color: "#a1a1aa", fontSize: 11, fontVariantNumeric: "tabular-nums" }}>0:15</small>
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginTop: 10 }}>
          {SAMPLE.slice(1).map(item => <img key={`strip-${item.src}`} src={item.src} alt={item.title} style={{ width: "100%", aspectRatio: "16 / 9", objectFit: "cover", borderRadius: 8, border: "1px solid #232328", display: "block" }} />)}
        </div>
      </aside>
    </div>

    <section aria-label="最近作品" style={{ display: "grid", gap: 12 }}>
      <h2 style={{ margin: 0, color: "#f4f4f5", fontSize: 16, fontWeight: 600 }}>最近作品</h2>
      {projects.length > 0
        ? <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 240px), 1fr))", gap: 10 }}>
          {projects.slice(0, 3).map(project => {
            const accent = THEME_ACCENT[project.theme] ?? "#7c8cff";
            return <button key={project.id} type="button" onClick={() => onOpen(project)} style={{ display: "flex", alignItems: "center", gap: 12, textAlign: "left", padding: "13px 14px", borderRadius: 12, border: "1px solid #26262b", background: "#121215", color: "#e4e4e7", font: "inherit", cursor: "pointer" }}>
              <span aria-hidden="true" style={{ width: 38, height: 38, borderRadius: 9, flex: "0 0 auto", display: "grid", placeItems: "center", background: `color-mix(in srgb, ${accent} 16%, transparent)`, color: accent, fontSize: 13, fontWeight: 700 }}>▶</span>
              <span style={{ display: "grid", gap: 3, minWidth: 0 }}><strong style={{ fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{project.name}</strong><small style={{ color: "#8b8b95", fontSize: 11 }}>{new Date(project.updatedAt).toLocaleString()} · {project.aspect}</small></span>
            </button>;
          })}
        </div>
        : <div style={{ padding: "18px 16px", borderRadius: 12, border: "1px dashed #2b2b31", color: "#8b8b95", fontSize: 13 }}>还没有作品。在上面生成第一支，它就会出现在这里。</div>}
    </section>

    <section aria-label="精选示例" style={{ display: "grid", gap: 14 }}>
      <h2 style={{ margin: 0, color: "#f4f4f5", fontSize: 16, fontWeight: 600 }}>精选示例</h2>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 260px), 1fr))", gap: 12 }}>
        {SAMPLE.slice(0, 4).map(item => <figure key={`gallery-${item.src}`} className="glint-gallery-card" style={{ margin: 0, display: "grid", gap: 9 }}>
          <div style={{ position: "relative", aspectRatio: "16 / 9", borderRadius: 12, overflow: "hidden", border: "1px solid #232328", background: "#121215" }}>
            <img src={item.src} alt={`${item.title} 的成片静帧`} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
          </div>
          <figcaption style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
            <span style={{ display: "grid", gap: 2, minWidth: 0 }}><strong style={{ color: "#e4e4e7", fontSize: 13, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.title}</strong><small style={{ color: "#8b8b95", fontSize: 11 }}>{item.meta}</small></span>
            <span style={{ padding: "3px 8px", borderRadius: 999, border: "1px solid #2b2b31", color: "#8b8b95", fontSize: 10, flex: "0 0 auto" }}>{item.tag}</span>
          </figcaption>
        </figure>)}
      </div>
    </section>
  </section>;
}
