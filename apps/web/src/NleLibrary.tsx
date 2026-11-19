import { applicationUrl } from "./app-url";
import { useState, type CSSProperties } from "react";
import type { NleProject } from "@glintai/scenescript";
import { NleCatalog } from "./NleCatalog";
import type { CatalogTarget } from "./nle-catalog";
import { button, colors, sub } from "./ui-tokens";

interface LibraryAsset { name: string; url: string; bytes: number }
interface Props {
  project: NleProject;
  target: CatalogTarget | null;
  assets: LibraryAsset[];
  onAddText(): void;
  onAddAsset(asset: LibraryAsset): void;
  onApply(project: NleProject): void;
}

function mediaKind(name: string): "image" | "video" | "audio" {
  if (/\.(png|jpe?g|webp)$/i.test(name)) return "image";
  return /\.mp4$/i.test(name) ? "video" : "audio";
}

export function NleLibrary({ project, target, assets, onAddText, onAddAsset, onApply }: Props) {
  const [tab, setTab] = useState<"assets" | "catalog">("assets");
  const variables = {
    "--catalog-text": colors.text, "--catalog-muted": colors.textMuted,
    "--catalog-surface": colors.surface, "--catalog-border": colors.border, "--catalog-accent": colors.accent,
  } as CSSProperties;
  return <aside className="nle-library" aria-label="素材库" style={variables}>
    <div className="nle-library-nav" role="group" aria-label="素材库视图">
      <button type="button" style={button} aria-pressed={tab === "assets"} onClick={() => setTab("assets")}>素材</button>
      <button type="button" style={button} aria-pressed={tab === "catalog"} onClick={() => setTab("catalog")}>滤镜与转场</button>
    </div>
    {tab === "catalog" ? <NleCatalog project={project} target={target} onApply={onApply} /> : <>
      <button type="button" style={button} onClick={onAddText}>+ 文字</button>
      {assets.map(asset => {
        const kind = mediaKind(asset.name);
        return <div key={asset.name} style={{ display: "grid", gap: 6, padding: 6, border: `1px solid ${colors.border}`, borderRadius: 9 }}>
          {kind === "image" ? <img src={applicationUrl(asset.url)} alt="" loading="lazy" style={{ width: "100%", height: 54, objectFit: "cover", borderRadius: 5 }} />
            : kind === "video" ? <video src={applicationUrl(asset.url)} muted preload="metadata" style={{ width: "100%", height: 54, objectFit: "cover", borderRadius: 5 }} />
              : <span style={{ ...sub, textAlign: "center", padding: 8 }}>音频</span>}
          <small title={asset.name} style={{ ...sub, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11 }}>{asset.name}</small>
          <button type="button" style={{ ...button, padding: "4px 7px", fontSize: 11 }} onClick={() => onAddAsset(asset)}>{kind === "audio" ? "加入音频轨" : "加入画面轨"}</button>
        </div>;
      })}
      {!assets.length && <p style={sub}>素材库为空。先在首页生成或导入素材，再回到剪辑台；也可添加文字片段预览滤镜与转场。</p>}
    </>}
  </aside>;
}
