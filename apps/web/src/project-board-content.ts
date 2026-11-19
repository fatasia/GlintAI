import { buildTimeline, parseProject, parseProjectWorkspace, type ProjectWorkspace, type SceneScriptProject } from "@glintai/scenescript";
import { validateProjectDocuments, type ProjectDocuments } from "./script-documents";
import { boardPosition } from "./project-board-layout";
import { boardAssets } from "./project-board-assets";

export type BoardContent = { project: SceneScriptProject; scripts: ProjectDocuments; workspace: ProjectWorkspace };
export type BoardContentAction = { kind: "duplicate" | "delete" | "group" | "ungroup"; keys: string[] } | { kind: "rename"; keys: string[]; title: string };
export function boardContentKeys(state: BoardContent): string[] {
  return [...state.project.scenes.map(scene => `scene:${scene.id}`), ...state.scripts.documents.map(doc => `script:${doc.id}`),
    ...state.workspace.designs.documents.flatMap(doc => doc.pages.map(page => `design:${doc.id}:${page.id}`))];
}
/** One immutable document-level operation. Assets are never deleted by deleting their references. */
export function changeBoardContent(before: BoardContent, action: BoardContentAction, newId: () => string = () => crypto.randomUUID()): BoardContent {
  if (before.project.frozen) throw new Error("工程已冻结，请先解冻再修改内容。");
  const known = [...boardContentKeys(before),...(action.kind==="group"||action.kind==="ungroup"?boardAssets(before.project,before.workspace.assets).map(asset=>`asset:${asset.name}`):[])], selected = new Set(action.keys);
  if (!selected.size || selected.size !== action.keys.length || action.keys.some(key => !known.includes(key))) throw new Error("请选择当前项目中的镜头、脚本或设计页；素材原文件请在素材库管理。");
  if (action.kind === "rename" && (selected.size !== 1 || !action.title.trim() || action.title.trim().length > 200)) throw new Error("请选择一项并输入 1 到 200 字的名称。");
  const next = structuredClone(before), copies: Array<[string, string]> = [];
  const positions = { ...(before.workspace.board?.positions ?? {}) };
  if(action.kind==="group"||action.kind==="ungroup"){
    const groups=before.workspace.board?.groups??[],overlapping=groups.filter(group=>group.members.some(key=>selected.has(key)));
    const remaining=groups.filter(group=>!overlapping.includes(group));
    if(action.kind==="group"){
      for(const group of overlapping)for(const key of group.members)if(known.includes(key))selected.add(key);
      if(selected.size<2)throw new Error("至少选择两项内容编组。");
      remaining.push({id:`group-${newId().slice(0,30)}`,title:`编组 ${groups.length+1}`,members:[...selected]});
    }else if(!overlapping.length)throw new Error("选中内容不在编组内。");
    next.workspace=parseProjectWorkspace({...next.workspace,board:{...next.workspace.board,positions,groups:remaining}},next.project.id);
    return next;
  }
  next.project.scenes = next.project.scenes.flatMap(scene => {
    const key = `scene:${scene.id}`;
    if (!selected.has(key)) return [scene];
    if (scene.locked) throw new Error("选中镜头已锁定，请先解锁。");
    if (action.kind === "delete") return [];
    if (action.kind === "rename") {
      if ("title" in scene) return [{ ...scene, title: action.title.trim() }];
      if ("heading" in scene) return [{ ...scene, heading: action.title.trim() }];
      throw new Error("此镜头没有独立标题，请进入编辑器修改内容。");
    }
    const copy = { ...structuredClone(scene), id: `copy-${newId().slice(0, 30)}` };
    copies.push([key, `scene:${copy.id}`]); return [scene, copy];
  });
  if (!next.project.scenes.length || next.project.scenes.length > 30) throw new Error("工程需要保留 1 到 30 个镜头。");
  const timeline = new Map(buildTimeline(before.project).entries.map(entry => [entry.scene.id, entry.startMs]));
  if (buildTimeline(next.project).entries.some(entry => entry.scene.locked && timeline.get(entry.scene.id) !== entry.startMs)) throw new Error("此操作会改变锁定镜头的开始时间，请先解锁后再操作。");
  next.scripts.documents = next.scripts.documents.flatMap(doc => {
    const key = `script:${doc.id}`; if (!selected.has(key)) return [doc];
    if (action.kind === "delete") return [];
    if (action.kind === "rename") return [{ ...doc, title: action.title.trim(), updatedAt: Date.now() }];
    const copy = { ...doc, id: newId(), title: `${doc.title} 副本`, updatedAt: Date.now() };
    copies.push([key, `script:${copy.id}`]); return [doc, copy];
  });
  if (!next.scripts.documents.some(doc => doc.id === next.scripts.activeId)) next.scripts.activeId = next.scripts.documents[0]?.id ?? "";
  next.workspace.designs.documents = next.workspace.designs.documents.flatMap(doc => {
    let changed = false;
    doc.pages = doc.pages.flatMap(page => {
      const key = `design:${doc.id}:${page.id}`; if (!selected.has(key)) return [page];
      changed = true;
      if (action.kind === "delete") return [];
      if (action.kind === "rename") return [{ ...page, title: action.title.trim() }];
      const copy = { ...structuredClone(page), id: newId(), title: `${page.title} 副本` };
      copies.push([key, `design:${doc.id}:${copy.id}`]); return [page, copy];
    });
    if (!doc.pages.length) return [];
    if (!doc.pages.some(page => page.id === doc.activePageId)) doc.activePageId = doc.pages[0]!.id;
    if (changed) doc.updatedAt = Date.now();
    return [doc];
  });
  if (!next.workspace.designs.documents.some(doc => doc.id === next.workspace.designs.activeId)) next.workspace.designs.activeId = next.workspace.designs.documents[0]?.id ?? "";
  if (action.kind === "delete") for (const key of selected) delete positions[key];
  for (const [source, target] of copies) {
    const point = positions[source] ?? boardPosition(known.indexOf(source));
    positions[target] = { x: point.x + 36, y: point.y + 36 };
  }
  next.workspace.board = { ...next.workspace.board, positions };
  if(next.workspace.board.groups){
    const copyKeys=new Map(copies);
    const copiedGroups=action.kind==="duplicate"?next.workspace.board.groups.filter(group=>group.members.every(key=>copyKeys.has(key))).map(group=>({...group,id:`group-${newId().slice(0,30)}`,title:`${group.title} 副本`,members:group.members.map(key=>copyKeys.get(key)!)})):[];
    next.workspace.board.groups=[...next.workspace.board.groups.map(group=>({...group,members:group.members.filter(key=>action.kind!=="delete"||!selected.has(key))})).filter(group=>group.members.length>1),...copiedGroups];
  }
  next.project = parseProject(next.project);
  next.scripts = validateProjectDocuments(next.scripts, next.project.id);
  next.workspace = parseProjectWorkspace(next.workspace, next.project.id);
  return next;
}

/** Generation receipts/viewport can advance independently and must not be rewound by document undo. */
export function boardContentIdentity(state: BoardContent): string {
  return JSON.stringify([state.project, state.scripts.documents, state.workspace.designs.documents, state.workspace.board?.positions ?? {},state.workspace.board?.groups??[]]);
}
