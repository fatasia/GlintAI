import { lazy, Suspense, useState, useEffect, useRef } from "react";
import type { SceneScriptProject } from "@glintai/scenescript";
import type { DesignDocument, DesignExportContext, DesignKind, DesignSelection, ProjectDesignDocuments } from "./design-artifacts";
import { DesignExportPanel } from "./DesignExportPanel";
import type { ArtifactEditRequest, DesignEditHandle } from "./artifact-project";
import type { ScriptHistoryState } from "./script-documents";
import { readBrandTheme, type BrandTheme } from "./design-brand";
import { appendRenderedSlides, captureDesignTheme } from "./design-to-video";

const DesignEditor = lazy(() => import("./DesignEditor").then(module => ({ default: module.DesignEditor })));
type ProjectDesignWorkspaceProps = {
  openTarget?: { id: string; pageId?: string; nonce: number };
  project: SceneScriptProject; initialKind?: DesignKind; state?: ProjectDesignDocuments; revision?: number;
  onChange(state: ProjectDesignDocuments): void; onSelection(selection: DesignSelection): void;
  onReview?(request: ArtifactEditRequest): void; editHandle?: { current: DesignEditHandle | null };
  onHistoryChange?(state: ScriptHistoryState): void;
  onAppendSlides?(project: SceneScriptProject): void;
};
export function ProjectDesignWorkspace(props: ProjectDesignWorkspaceProps) {
  return <DesignWorkspace key={props.project.id} {...props} />;
}
function DesignWorkspace({ openTarget, project, initialKind, state, revision, onChange, onSelection, onReview, editHandle, onHistoryChange, onAppendSlides }: ProjectDesignWorkspaceProps) {
  const [exporting, setExporting] = useState<{ document: DesignDocument; brand: BrandTheme | null } | null>(null);
  const [videoProgress,setVideoProgress]=useState("");
  const conversion=useRef<AbortController|null>(null), latest=useRef({project,state});latest.current={project,state};
  useEffect(()=>()=>conversion.current?.abort(),[]);
  return <div className="project-design-workspace">
    <Suspense fallback={<p role="status">正在打开设计文档…</p>}>
      <DesignEditor openTarget={openTarget} projectId={project.id} title={project.title} initialKind={initialKind} externalState={state} revision={revision}
        onVideo={onAppendSlides ? async document => {
          if(conversion.current)throw new Error("已有转换正在进行。");
          const controller=new AbortController();conversion.current=controller;
          const before=JSON.stringify(project), source=JSON.stringify(document);
          try {
            const next=await appendRenderedSlides(project,document,{id:`slides-${crypto.randomUUID().slice(0,8)}`,theme:captureDesignTheme(),brand:readBrandTheme(project.id).theme,signal:controller.signal,onProgress:(current,total)=>setVideoProgress(`正在准备第 ${current} / ${total} 页`)});
            if(JSON.stringify(latest.current.project)!==before || JSON.stringify(latest.current.state?.documents.find(item=>item.id===document.id))!==source)
              throw new Error("转换期间工程或设计有新修改，未覆盖当前版本；已生成图片保留在素材库。");
            onAppendSlides(next);
          } finally {conversion.current=null;setVideoProgress("");}
        } : undefined}
        onDocumentsChange={onChange} onSelection={onSelection} onReview={onReview} editHandle={editHandle} onHistoryChange={onHistoryChange} onExport={({ document }: DesignExportContext) => { setExporting({ document, brand: readBrandTheme(project.id).theme }); }} />
    </Suspense>
    {videoProgress && <div role="status">{videoProgress} <button className="g-btn" type="button" onClick={()=>conversion.current?.abort()}>取消转换</button></div>}
    {exporting && <div className="editor-git-layer"><button type="button" className="editor-git-backdrop" aria-label="关闭设计导出" onClick={() => setExporting(null)} />
      <div className="editor-git-panel"><DesignExportPanel document={exporting.document} brand={exporting.brand} onClose={() => setExporting(null)} /></div>
    </div>}
  </div>;
}
