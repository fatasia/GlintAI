import { boardContentIdentity, changeBoardContent, type BoardContent, type BoardContentAction } from "./project-board-content";
import { applicationUrl } from "./app-url";
import { lazy, Suspense, useRef, useState } from "react";
import { projectBoardGroupsSchema, type SceneScriptProject } from "@glintai/scenescript";
import type { ProjectDocuments } from "./script-documents";
import type { ProjectDesignDocuments } from "./design-artifacts";
import { DesignThumb } from "./design-editor-preview";
import "./design-editor.css";
import { GenerationSurface } from "./GenerationSurface";
import { sceneDisplayTitle } from "./editor-model";
import { arrangeBoard, boardPosition, moveBoardGroups, BOARD_CARD, type BoardArrange } from "./project-board-layout";
import { readProjectAssetsStrict } from "./design-assets";
import { boardAssets, type BoardAsset } from "./project-board-assets";
const GenCanvasBoard = lazy(() => import("./GenCanvasBoard").then(module => ({default:module.GenCanvasBoard})));
export type ProjectBoardTarget = { kind: "scene" | "script" | "design" | "asset"; id: string; pageId?: string };
export function projectBoardItems(project: SceneScriptProject, scripts: ProjectDocuments, designs: ProjectDesignDocuments, assets: BoardAsset[] = []) {
  return [
    ...project.scenes.map(scene => ({ key: `scene:${scene.id}`, title: sceneDisplayTitle(scene), detail: scene.narration.text, target: { kind: "scene" as const, id: scene.id } })),
    ...scripts.documents.map(doc => ({ key: `script:${doc.id}`, title: doc.title, detail: doc.content.slice(0, 160), target: { kind: "script" as const, id: doc.id } })),
    ...designs.documents.flatMap(doc => doc.pages.map(page => ({ key: `design:${doc.id}:${page.id}`, title: `${doc.title} / ${page.title}`, detail: doc.kind === "slides" ? "幻灯片" : "设计页面", html: page.html, target: { kind: "design" as const, id: doc.id, pageId: page.id } }))),
    ...assets.map(asset=>({key:`asset:${asset.name}`,title:asset.name,detail:asset.usedBy.length ? `用于 ${asset.usedBy.length} 个镜头` : "项目参考素材",asset,target:{kind:"asset" as const,id:asset.name}})),
  ];
}
type Positions = Record<string, { x: number; y: number }>;
export function ProjectBoard({ project, scripts, designs, onOpen, onAdoptAsset, captureContent, onContentChange, onUndoContent, onRedoContent, canUndoContent, canRedoContent, onOpenTimeline }: { onOpenTimeline?():void; captureContent?():BoardContent; onContentChange?(action:BoardContentAction,next:BoardContent,expected:string):void; onUndoContent?():void; onRedoContent?():void; canUndoContent?:boolean; canRedoContent?:boolean; project: SceneScriptProject; scripts: ProjectDocuments; designs: ProjectDesignDocuments; onOpen(target: ProjectBoardTarget): void; onAdoptAsset?(name:string):void }) {
  const key = `glint:project-board:v1:${project.id}`;
  const [initial] = useState(() => {
    try {
      const raw = localStorage.getItem(key);
      const value = JSON.parse(raw ?? "{}");
      if (!value || Array.isArray(value) || typeof value !== "object" || Object.keys(value).length > 1500 || Object.entries(value).some(([id, p]) => {
        const point = p as {x:number;y:number}; return id.length > 500 || !point || ![point.x,point.y].every(n => Number.isFinite(n) && Math.abs(n) <= 100000);
      })) throw new Error();
      return { positions: value as Positions, raw, error: "" };
    } catch { return { positions: {} as Positions, error: "画布布局无法读取，原记录保留；暂不能保存新布局。" }; }
  });
  const [groupState]=useState(()=>{try{return {groups:projectBoardGroupsSchema.parse(JSON.parse(localStorage.getItem(`glint:project-board:groups:v1:${project.id}`)??"[]")),error:""};}catch{return{groups:[],error:"画布编组无法读取，原记录保留；请先备份。"};}});
  const savedRaw = useRef(initial.raw ?? null);
  const [positions, setPositions] = useState(initial.positions), [error, setError] = useState(initial.error), [query, setQuery] = useState("");
  const [history, setHistory] = useState<Positions[]>([]), [future, setFuture] = useState<Positions[]>([]);
  const [selection, setSelection] = useState<string[]>([]);
  const [pending, setPending] = useState<{action:BoardContentAction; next:BoardContent; expected:string}>();
  const [renameTitle, setRenameTitle] = useState("");
  const changeContent = (action:BoardContentAction) => {
    try {
      if (!captureContent || !onContentChange) return;
      const before=captureContent(), next=changeBoardContent(before,action), expected=boardContentIdentity(before);
      if (action.kind === "delete") {setPending({action,next,expected});return;}
      onContentChange(action,next,expected);setError("");
    } catch(cause) {setError(cause instanceof Error ? cause.message : "内容未修改。");}
  };
  const [generationOpen, setGenerationOpen] = useState(false);
  const [previewAsset,setPreviewAsset] = useState<BoardAsset | null>(null), [assetError,setAssetError] = useState("");
  const save = (next: Positions) => {
    if (initial.error || groupState.error) return false;
    try {
      if (localStorage.getItem(key) !== savedRaw.current) { setError("画布布局已在其他窗口更新；请重新打开项目后继续，当前记录未覆盖。"); return false; }
      const raw = JSON.stringify(next); localStorage.setItem(key, raw); if (localStorage.getItem(key) !== raw) throw new Error(); savedRaw.current = raw; setPositions(next); setError(""); return true;
    }
    catch { setError("布局未保存，原位置仍保留。请检查本机存储。"); return false; }
  };
  const move = (next: Positions) => { if(save(next)) { setHistory([...history.slice(-49), positions]); setFuture([]); } };
  let assets: BoardAsset[] = [], assetsError = "";
  try { assets = boardAssets(project,readProjectAssetsStrict(project.id)); }
  catch { assetsError = "项目素材索引无法读取，原记录保留；请先核对备份。"; }
  const items = projectBoardItems(project, scripts, designs,assets);
  const open = (target:ProjectBoardTarget) => { if(target.kind === "asset") {setPreviewAsset(assets.find(asset=>asset.name === target.id) ?? null);setAssetError("");} else onOpen(target); };
  const arrange = (action: BoardArrange) => move(arrangeBoard(Object.fromEntries(items.map((item,index)=>[item.key,positions[item.key] ?? boardPosition(index)])),selection,action));
  return <section aria-label="项目画布" style={{display:"grid",gap:10,minWidth:0}}>
    <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}><strong>项目画布</strong><input style={{background:"var(--ink-2)",color:"var(--paper)",border:"1px solid var(--line-2)",padding:8,borderRadius:8}} aria-label="查找画布内容" placeholder="查找页面、脚本、镜头" value={query} onChange={event=>setQuery(event.target.value)} />
      <button type="button" className="g-btn g-btn--sm" onClick={()=>move({})}>整理</button><button type="button" className="g-btn g-btn--sm" disabled={!history.length} onClick={()=>{if(save(history.at(-1)!)){setHistory(history.slice(0,-1));setFuture([...future,positions]);}}}>撤销布局</button><button type="button" className="g-btn g-btn--sm" disabled={!future.length} onClick={()=>{if(save(future.at(-1)!)){setFuture(future.slice(0,-1));setHistory([...history,positions]);}}}>重做布局</button></div>
    {onOpenTimeline && <button className="g-btn g-btn--sm" style={{justifySelf:"start"}} onClick={()=>{try{onOpenTimeline();}catch(cause){setError(cause instanceof Error?cause.message:"剪辑未打开。");}}}>进入项目剪辑</button>}
    <small>双击进入编辑器。复制、删除会修改对应内容；拖动只调整画布位置。</small>
    <div role="toolbar" aria-label="画布排列" style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}><small>{selection.length ? `已选 ${selection.length} 项` : "拖动框选，Shift 加选；中键平移"}</small>{([["left","左对齐"],["top","顶对齐"],["horizontal","水平分布"],["vertical","垂直分布"]] as const).map(([action,label])=><button key={action} type="button" className="g-btn g-btn--sm" disabled={selection.length<2} onClick={()=>arrange(action)}>{label}</button>)}</div>
    {onContentChange && <div role="toolbar" aria-label="画布内容操作" style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
      <button className="g-btn g-btn--sm" disabled={!selection.length || project.frozen} onClick={()=>changeContent({kind:"duplicate",keys:selection})}>复制所选</button>
      <button className="g-btn g-btn--sm" disabled={!selection.length || project.frozen} onClick={()=>changeContent({kind:"delete",keys:selection})}>删除所选</button>
      <button className="g-btn g-btn--sm" disabled={selection.length<2 || project.frozen} onClick={()=>changeContent({kind:"group",keys:selection})}>编组</button>
      <button className="g-btn g-btn--sm" disabled={!selection.some(id=>groupState.groups.some(group=>group.members.includes(id))) || project.frozen} onClick={()=>changeContent({kind:"ungroup",keys:selection})}>取消编组</button>
      <button className="g-btn g-btn--sm" disabled={!canUndoContent} onClick={onUndoContent}>撤销内容</button>
      <button className="g-btn g-btn--sm" disabled={!canRedoContent} onClick={onRedoContent}>重做内容</button>
      {selection.length === 1 && <form style={{display:"flex",gap:4}} onSubmit={event=>{event.preventDefault();changeContent({kind:"rename",keys:selection,title:renameTitle});}}>
        <input aria-label="画布内容新名称" placeholder="新名称" maxLength={200} value={renameTitle} onChange={event=>setRenameTitle(event.target.value)} style={{width:140,minWidth:0}}/>
        <button className="g-btn g-btn--sm" disabled={!renameTitle.trim() || project.frozen}>重命名</button>
      </form>}
    </div>}
    {pending && <div role="alertdialog" aria-label="确认删除画布内容" style={{padding:12,border:"1px solid var(--line-2)",borderRadius:8}}>
      <p>删除选中的 {pending.action.keys.length} 项内容？这会删除镜头、脚本或设计页；素材原文件不受影响。</p>
      <button className="g-btn" onClick={()=>{try{onContentChange?.(pending.action,pending.next,pending.expected);setPending(undefined);setError("");}catch(cause){setError(cause instanceof Error ? cause.message:"未删除内容。");setPending(undefined);}}}>确认删除内容</button>
      <button className="g-btn" onClick={()=>setPending(undefined)}>取消删除</button>
    </div>}
    <GenerationSurface onSelection={setSelection} viewportKey={`glint:project-board:viewport:v1:${project.id}`} minimap={false} edges={[]} onCreate={()=>{}} onMove={moved=>{try{move(moveBoardGroups(Object.fromEntries(items.map((item,index)=>[item.key,positions[item.key]??boardPosition(index)])),moved,groupState.groups));}catch(cause){setError(cause instanceof Error?cause.message:"移动未保存。");}}} items={items.map((item,index)=>({...item,index})).filter(item=>`${item.title} ${item.detail}`.toLowerCase().includes(query.toLowerCase())).map(item=>({
      id:item.key, position:positions[item.key] ?? boardPosition(item.index), content:<article onDoubleClick={()=>open(item.target)} style={{background:"var(--ink-2)",border:"1px solid var(--line-2)",borderRadius:12,padding:14,width:BOARD_CARD.width,height:BOARD_CARD.height,boxSizing:"border-box",display:"flex",flexDirection:"column",gap:6,overflow:"hidden"}}>
      {"asset" in item && (item.asset.kind === "image" ? <img src={applicationUrl(item.asset.url)} alt="" loading="lazy" style={{height:110,width:"100%",objectFit:"contain"}}/> : <video src={applicationUrl(item.asset.url)} muted preload="metadata" style={{height:110,width:"100%",objectFit:"contain"}}/>)}{"html" in item && <DesignThumb html={item.html} title={item.title} />}<small>{groupState.groups.find(group=>group.members.includes(item.key))?.title && <span style={{color:"var(--g-accent-text)",marginRight:8}}>{groupState.groups.find(group=>group.members.includes(item.key))!.title}</span>}{item.target.kind === "scene" ? "视频镜头" : item.target.kind === "script" ? "脚本" : item.target.kind === "asset" ? "项目素材" : "设计"}</small><h4 title={item.title} style={{margin:"2px 0",overflow:"hidden",display:"-webkit-box",WebkitLineClamp:2,WebkitBoxOrient:"vertical",overflowWrap:"anywhere",flexShrink:0}}>{item.title}</h4><p style={{fontSize:12,margin:0,overflow:"hidden",display:"-webkit-box",WebkitLineClamp:3,WebkitBoxOrient:"vertical",overflowWrap:"anywhere"}}>{item.detail}</p><button type="button" style={{marginTop:"auto",flexShrink:0}} className="nodrag g-btn g-btn--sm" onClick={()=>open(item.target)}>{item.target.kind === "asset" ? "查看素材" : "打开编辑"}</button></article>
    }))} />
    {error && <p role="alert">{error}</p>}
    {groupState.error && <p role="alert">{groupState.error}</p>}
    {assetsError && <p role="alert">{assetsError}</p>}
    {previewAsset && <dialog ref={node=>{if(node&&!node.open)node.showModal();}} aria-label="项目素材预览" onClose={()=>setPreviewAsset(null)} style={{position:"fixed",inset:"8vh max(16px, 10vw)",margin:0,width:"auto",height:"auto",zIndex:100,color:"var(--paper)",background:"var(--ink-1)",border:"1px solid var(--line-2)",borderRadius:12,padding:16,display:"flex",flexDirection:"column",gap:12,boxShadow:"0 20px 80px #0008"}}>
      <header style={{display:"flex",gap:12,justifyContent:"space-between"}}><strong style={{overflowWrap:"anywhere"}}>{previewAsset.name}</strong><button autoFocus className="g-btn" type="button" onClick={()=>setPreviewAsset(null)}>关闭预览</button></header>
      {previewAsset.kind === "video" ? <video controls src={applicationUrl(previewAsset.url)} style={{width:"100%",flex:1,minHeight:0,objectFit:"contain"}} onError={()=>setAssetError("素材无法读取，请在素材库核对文件是否仍存在。")}/> : <img src={applicationUrl(previewAsset.url)} alt={previewAsset.name} style={{width:"100%",flex:1,minHeight:0,objectFit:"contain"}} onError={()=>setAssetError("素材无法读取，请在素材库核对文件是否仍存在。")}/>}
      <small>{previewAsset.usedBy.length ? `引用镜头：${previewAsset.usedBy.join("、")}` : "项目参考素材，尚未用于视频镜头"}</small>
      {onAdoptAsset && <button className="g-btn" type="button" disabled={!!assetError || project.frozen} onClick={()=>{try{onAdoptAsset(previewAsset.name);setPreviewAsset(null);}catch(cause){setAssetError(cause instanceof Error ? cause.message : "素材未采用。");}}}>添加为新镜头</button>}
      {assetError && <p role="alert">{assetError}</p>}
    </dialog>}
    <details onToggle={event=>setGenerationOpen(event.currentTarget.open)}><summary>项目生成任务</summary>{generationOpen && <Suspense fallback={<p role="status">正在打开生成任务…</p>}><p>本项目的提示词、连线和任务回执独立保存。生成结果进入素材库，再从“镜头顺序与素材采用”加入视频。</p><GenCanvasBoard projectId={project.id} /></Suspense>}</details>
  </section>;
}
