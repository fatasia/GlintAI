import { designEntranceTimeline, readDesignEntrance } from "./design-animation";
import { sceneTransitionFor } from "./design-transition";
import { appFetch as fetch } from "./app-url";
import { parseProject, type SceneScriptProject } from "@glintai/scenescript";
import { validateDesignDocuments, type DesignDocument } from "./design-artifacts";
import { brandExportDocument, type BrandTheme } from "./design-brand";
import { exportDesignDocument } from "./design-export-client";

const themeKeys = ["--ink-0", "--ink-1", "--ink-2", "--ink-3", "--ink-4", "--paper", "--paper-dim", "--muted", "--faint", "--accent", "--accent-ink", "--line-1", "--line-2", "--line-3", "--r-sm", "--r-md", "--font-ui"];
export function captureDesignTheme(): Record<string,string> {
  const style = getComputedStyle(document.documentElement);
  return Object.fromEntries(themeKeys.map(key => [key, style.getPropertyValue(key).trim()]).filter(([,value]) => value));
}
/** Append editable HTML snapshots to the existing project; source documents and scenes are retained. */
export function appendDesignSlides(project: SceneScriptProject, source: DesignDocument, options: { id: string; theme?: Record<string,string>; brand?: BrandTheme | null }): SceneScriptProject {
  if (project.frozen) throw new Error("工程已冻结，请先创建可编辑副本。");
  if (source.kind !== "slides") throw new Error("请选择幻灯片文档。");
  validateDesignDocuments({version:1,projectId:project.id,activeId:source.id,documents:[source]},project.id);
  if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(options.id)) throw new Error("转换编号无效。");
  const doc = brandExportDocument(source, options.brand ?? null);
  const css = Object.entries(options.theme ?? {}).map(([key,value]) => {
    if (!themeKeys.includes(key) || /[<>;{}]/.test(value)) throw new Error("主题变量无效。");
    return `${key}:${value}`;
  }).join(";");
  const scenes = doc.pages.map((page,index) => {
    const parsed = new DOMParser().parseFromString(page.html,"text/html");
    const timeline=designEntranceTimeline(parsed);
    if (parsed.querySelector("script,iframe,object,embed") || [...parsed.querySelectorAll("style,[style]")].some(element => /animation(?:-name|-duration)?\s*:/i.test(element.tagName === "STYLE" ? element.textContent ?? "" : element.getAttribute("style") ?? "")))
      throw new Error(`“${page.title}”含脚本或 CSS 动画，请先转为静态页面；视频动画在镜头编辑器中添加。`);
    // Capture has a fixed viewport and an already-decoded Unicode document.
    // Remove only redundant metadata here; other export warnings still block conversion.
    parsed.querySelectorAll('meta[charset],meta[name="viewport"]').forEach(node=>node.remove());
    // Let the static exporter measure taller pages. The video image uses contain;
    // forcing overflow:hidden here would silently discard the source footer.
    const style=parsed.createElement("style"); style.dataset.glintVideoTheme="true";style.textContent=`:root{${css}}html,body{width:1280px;min-height:720px;margin:0}`;
    // Base theme first; project brand and source-local overrides retain precedence.
    parsed.head.prepend(style);
    if(timeline){
      // Managed media must be embedded before the page enters the offline renderer.
      if(parsed.querySelector('[src]:not([src^="data:"]),link')||[...parsed.querySelectorAll('style,[style]')].some(node=>/url\s*\(|@import/i.test(node.tagName==='STYLE'?node.textContent??'':node.getAttribute('style')??'')))throw new Error(`“${page.title}”动画页含外部素材，请先嵌入图片再转换。`);
      // No inline timeline script here: converted pages rasterize through the
      // script-disabled static exporter (warnings fail the conversion), and the
      // seekable in-house runtime stays available via designEntranceTimeline.
    }
    const narration=page.notes?.trim() || page.title;
    const pageTransition=sceneTransitionFor(page);
    const animationDuration=timeline?Math.max(...[...parsed.querySelectorAll('[data-design-enter]')].map(node=>{const enter=readDesignEntrance(node);return enter.delayMs+enter.durationMs;}))+500:0;
    return {id:`${options.id}-${index+1}`,kind:"html" as const,presentation:"slide" as const,
      html:`<!doctype html>\n${parsed.documentElement.outerHTML}`,narration:{text:narration,...(animationDuration?{durationMs:Math.max(animationDuration,Math.min(120000,narration.length*250))}:{})},
      notes:`设计来源：${source.title} / ${page.title}\n文档 ${source.id}，页面 ${page.id}。这是转换时的可编辑快照。`,...(pageTransition?{transition:pageTransition}:{})};
  });
  const ids=new Set(project.scenes.map(scene=>scene.id));
  if(scenes.some(scene=>ids.has(scene.id)))throw new Error("镜头编号冲突，请重新转换。");
  return parseProject({...project,scenes:[...project.scenes,...scenes]});
}

/** Rasterize in the existing isolated design exporter, then use the normal media/video pipeline. */
export async function appendRenderedSlides(project: SceneScriptProject, source: DesignDocument, options: Parameters<typeof appendDesignSlides>[2] & { signal: AbortSignal; onProgress?: (current: number,total: number) => void }): Promise<SceneScriptProject> {
  if(project.scenes.length+source.pages.length>30)throw new Error("视频最多 30 个镜头，请先减少镜头或幻灯片。");
  const prepared=appendDesignSlides(project,source,options), added=prepared.scenes.slice(project.scenes.length);
  const images: SceneScriptProject["scenes"]=[];
  for(let index=0;index<added.length;index++) {
    options.signal.throwIfAborted(); options.onProgress?.(index+1,added.length);
    const scene=added[index]!;if(scene.kind!=="html")throw new Error("幻灯片转换类型无效。");
    if(scene.animation){images.push(scene);continue;}
    const page={...source.pages[index]!,html:scene.html};
    const result=await exportDesignDocument({...source,pages:[page],activePageId:page.id},"png",options.signal);
    if(result.warnings.length)throw new Error(`“${page.title}”导出需要核对：${result.warnings.join("；")}`);
    const response=await fetch(result.url,{signal:options.signal});
    if(!response.ok || !response.headers.get("content-type")?.startsWith("image/png"))throw new Error("幻灯片图片读取失败，未修改视频。");
    const image=await response.blob();
    if(!image.size || image.size>8*1024*1024)throw new Error("幻灯片图片为空或超过 8 MB，请减少页面素材。");
    const uploaded=await fetch("/api/media/import-image",{method:"POST",headers:{"content-type":"image/png"},body:image,signal:options.signal});
    const asset=await uploaded.json();
    if(!uploaded.ok || typeof asset.name!=="string" || !/^[a-zA-Z0-9_-]{1,100}\.png$/.test(asset.name))throw new Error("幻灯片图片未能保存到素材库，视频未修改。");
    images.push({id:scene.id,kind:"image",src:`assets/${asset.name}`,presentation:"slide",narration:scene.narration,notes:scene.notes,transition:scene.transition,provenance:{origin:"generated",source:`design:${source.id}/${page.id}`}});
  }
  options.signal.throwIfAborted();
  return parseProject({...project,scenes:[...project.scenes,...images]});
}
