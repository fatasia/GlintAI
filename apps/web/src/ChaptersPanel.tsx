import { appFetch as fetch } from "./app-url";
import { useEffect, useMemo, useRef, useState } from "react";
import { type SceneScriptProject } from "@glintai/scenescript";
import { downloadJson } from "./editor-model";
import { captureChapter, chaptersDocument, CHAPTERS_KEY, MAX_CHAPTERS_BYTES, mergeChapters, moveChapter, parseChaptersDocument, readChapters, summarizeChapters, withChapterWriteLock, writeChapters, type ChapterContext, type ChapterSnapshot } from "./ChaptersStore";
import "./ChaptersPanel.css";
import { createPortableImportController } from "./portable-chapter-import";

type Pending = { kind: "open"; chapter: ChapterSnapshot } | { kind: "remove"; chapter: ChapterSnapshot } | { kind: "update"; chapter: ChapterSnapshot } | { kind: "import"; chapters: ChapterSnapshot[] } | { kind: "portable"; chapters: ChapterSnapshot[]; token: object };
const duration = (ms: number) => `${(ms / 1000).toFixed(1)} 秒`;
export interface ChaptersPanelProps {
  project: SceneScriptProject | null; context: ChapterContext; disabled?: boolean;
  onOpen(chapter: ChapterSnapshot): boolean;
  onCountChange?(count: number): void;
}
export function ChaptersPanel({ project, context, disabled = false, onOpen, onCountChange }: ChaptersPanelProps) {
  const [chapters, setChapters] = useState<ChapterSnapshot[]>([]), [loaded, setLoaded] = useState(false), [readFailed, setReadFailed] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [pending, setPending] = useState<Pending | null>(null), [consent, setConsent] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null), [name, setName] = useState("");
  const importRef = useRef<HTMLInputElement>(null), portableRef = useRef<HTMLInputElement>(null), importVersion = useRef(0);
  const [portableBusy, setPortableBusy] = useState(false);
  const portable = useMemo(() => {
    let preflightToken = "";
    const request = async (url: string, serialized: string, confirmed = false) => {
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(confirmed ? { "x-glint-confirm-import": preflightToken } : {}) }, body: serialized });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "章节迁移失败，请保留原包后重试。");
      return result;
    };
    return createPortableImportController({
      preflight: async serialized => { preflightToken = ""; const result = await request("/api/chapters/preview-bundle", serialized); if (typeof result.token !== "string" || !result.token) throw new Error("预检凭证无效，请重试。"); preflightToken = result.token; return result.chapters; },
      publish: async serialized => (await request("/api/chapters/commit-bundle", serialized, true)).chapters,
    }, localStorage);
  }, []);
  const signature = JSON.stringify({ project, context });
  const current = chapters.find(chapter => chapter.project.id === project?.id);
  const summary = useMemo(() => summarizeChapters(chapters), [chapters]);
  const refresh = () => {
    try { setChapters(readChapters()); setReadFailed(false); setError(""); }
    catch (error) { setReadFailed(true); setError(`无法读取本机章节：${error instanceof Error ? error.message : "存储不可用"}。原数据未修改。`); }
    setLoaded(true);
  };
  useEffect(() => {
    refresh();
    const changed = (event: StorageEvent) => { if (event.key === CHAPTERS_KEY || event.key === null) { refresh(); setPending(value => value?.kind === "portable" ? value : null); setConsent(false); setRenaming(null); } };
    window.addEventListener("storage", changed); return () => window.removeEventListener("storage", changed);
  }, []);
  useEffect(() => { if (loaded) onCountChange?.(chapters.length); }, [loaded, chapters.length, onCountChange]);
  // A confirmation never survives changes to the editor or a task starting.
  useEffect(() => { setPending(value => value?.kind === "portable" ? value : null); setConsent(false); importVersion.current++; }, [signature, disabled]);
  const blocked = disabled || !loaded || readFailed || portableBusy;
  const propose = (value: Pending) => { if (blocked) return; if (portable.hasPending()) { setError("请先完成或取消待处理的迁移包。"); return; } setPending(value); setConsent(false); setRenaming(null); setError(""); setNotice(""); };
  const commit = async (next: ChapterSnapshot[], message: string): Promise<boolean> => {
    if (blocked) return false;
    if (portable.hasPending()) { setError("请先完成或取消待处理的迁移包。"); return false; }
    try {
      return await withChapterWriteLock(() => {
        const latest = readChapters();
        if (JSON.stringify(latest) !== JSON.stringify(chapters)) { setChapters(latest); setPending(null); setRenaming(null); throw new Error("章节列表已被其他窗口更新，请检查列表后重试。"); }
        const saved = writeChapters(next); setChapters(saved); setPending(null); setRenaming(null); setConsent(false); setError(""); setNotice(message); return true;
      });
    } catch (error) { setError(`${error instanceof Error ? error.message : "本机写入失败"} 未保存本次修改；可导出已有章节 JSON 备份。`); return false; }
  };
  const saveCurrent = () => {
    if (blocked || !project) return;
    try {
      const chapter = captureChapter(project, context);
      if (current) propose({ kind: "update", chapter: { ...chapter, title: current.title } });
      else commit(mergeChapters(chapters, [chapter]), `已将「${chapter.title}」保存为本机章节。后续编辑需手动更新快照。`);
    } catch (error) { setError(error instanceof Error ? error.message : "无法保存章节"); }
  };
  const confirm = () => {
    if (blocked || !pending || !consent) return;
    if (pending.kind === "open") {
      try { if (onOpen(pending.chapter)) { setNotice(`已载入「${pending.chapter.title}」。章节快照不会自动更新。`); setPending(null); setConsent(false); } }
      catch (error) { setError(error instanceof Error ? error.message : "切换失败，当前工程未替换。"); }
    } else if (pending.kind === "portable") {
      setPortableBusy(true); setError(""); setNotice("正在验证并导入素材，请稍候。");
      void portable.confirm(pending.token).then(saved => { setChapters(saved); setPending(null); setConsent(false); setNotice("章节迁移完成，编辑区未切换。"); }).catch(error => { setError(`${error instanceof Error ? error.message : "导入失败"} 原包仍保留，可重试或取消后重新预检。`); }).finally(() => setPortableBusy(false));
    } else if (pending.kind === "remove") commit(chapters.filter(chapter => chapter.project.id !== pending.chapter.project.id), `已从列表移除「${pending.chapter.title}」；编辑区、全部作品与素材文件未删除。`);
    else if (pending.kind === "update") commit(chapters.map(chapter => chapter.project.id === pending.chapter.project.id ? pending.chapter : chapter), `已更新「${pending.chapter.title}」的本机快照。`);
    else {
      try { commit(mergeChapters(chapters, pending.chapters), `已添加 ${pending.chapters.length} 个本机章节，编辑区未切换。`); }
      catch (error) { setError(error instanceof Error ? error.message : "导入失败"); }
    }
  };
  return <div className="chapters-body">
      <div className="chapters-heading"><div><h3>章节工作台</h3><p>显式保存工程快照；切换后继续在下方编辑。</p></div><span className="chapters-local">仅此浏览器</span></div>
      <div className="chapters-toolbar">
        <button type="button" className="chapters-primary" disabled={blocked || !project} onClick={saveCurrent}>{current ? "更新当前章节快照" : "将当前工程加入章节"}</button>
        <button type="button" disabled={blocked || portable.hasPending()} onClick={() => importRef.current?.click()}>导入章节 JSON</button>
        <button type="button" disabled={!loaded || readFailed || !chapters.length} onClick={() => { downloadJson("glint-chapters.references.json", chaptersDocument(chapters)); setNotice("已导出章节引用 JSON；素材文件需另行备份。"); }}>导出章节 JSON</button>
        <button type="button" disabled title="含素材章节包暂不可用，安全条件尚未满足。" onClick={() => portableRef.current?.click()}>导入含素材包</button>
        <button type="button" disabled title="含素材章节包暂不可用，安全条件尚未满足。" onClick={async () => {
          setPortableBusy(true); setError(""); setNotice("正在验证素材并生成迁移包，请稍候。");
          try {
            const response = await fetch("/api/chapters/export-bundle", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chapters }) });
            const result = await response.json(); if (!response.ok) throw new Error(result.error || "导出失败。");
            downloadJson("glint-chapters.portable.json", result); setNotice("已导出含素材的章节迁移包，请妥善保管。");
          } catch (error) { setError(error instanceof Error ? error.message : "导出失败。"); setNotice(""); }
          finally { setPortableBusy(false); }
        }}>导出含素材包</button>
        <p className="chapters-hint">网页内含素材章节包暂不可用。Windows 桌面安装包提供独立本机工具：先导出章节 JSON，在命令提示符运行安装目录中的 Glint-chapters.cmd help；恢复后再导入工具生成的章节 JSON。工具需要 FFmpeg 和 ffprobe。</p>
        <input ref={portableRef} hidden type="file" aria-label="章节迁移包文件" accept=".json,application/json" disabled={blocked} onChange={async event => {
          const input = event.currentTarget, file = input.files?.[0]; if (!file || blocked) return;
          setPortableBusy(true); setError(""); setNotice("正在预检迁移包，尚未写入素材。");
          try {
            if (file.size > 32 * 1024 * 1024) throw new Error("迁移包超过 32 MiB。");
            const preview = await portable.preflight(await file.text());
            setPending({ kind: "portable", ...preview }); setConsent(false); setNotice("预检完成；确认前不会写入素材。");
          } catch (error) { setError(error instanceof Error ? error.message : "预检失败。"); setNotice(""); }
          finally { input.value = ""; setPortableBusy(false); }
        }} />
        <input ref={importRef} hidden type="file" aria-label="章节 JSON 文件" accept=".json,application/json" disabled={blocked} onChange={async event => {
          const input = event.currentTarget, file = input.files?.[0], version = ++importVersion.current;
          if (!file || blocked) return;
          try {
            if (file.size > MAX_CHAPTERS_BYTES) throw new Error("章节引用 JSON 超过 2 MB。");
            const imported = parseChaptersDocument(JSON.parse(await file.text()));
            if (version !== importVersion.current) return;
            if (!imported.chapters.length) throw new Error("文件没有可添加的章节。");
            mergeChapters(chapters, imported.chapters); propose({ kind: "import", chapters: imported.chapters });
          } catch (error) { if (version === importVersion.current) { setPending(null); setError(error instanceof Error ? error.message : "导入失败"); } }
          finally { input.value = ""; }
        }} />
      </div>
      {!project && <p className="chapters-hint">先生成或导入可编辑工程，再加入章节。这里不会拆分剧本或生成新镜头。</p>}
      {disabled && <p role="status" className="chapters-hint">当前任务仍在进行；完成或取消后再修改章节与切换工程。</p>}
      {chapters.length > 0 ? <>
        <div className="chapters-totals"><strong>{summary.scenes} 镜 <span>· {duration(summary.totalMs)}</span></strong><span>{summary.sharedAssets} 个跨章同版本资产 · {summary.sharedReferences} 个引用相同路径</span></div>
        <ol className="chapters-list" aria-label="章节列表">{chapters.map((chapter, index) => {
          const metrics = summary.chapters[index]!, editing = chapter.project.id === project?.id;
          const dirty = editing && JSON.stringify(chapter.project) !== JSON.stringify(project);
          return <li key={chapter.project.id} className={editing ? "is-current" : undefined}>
            <span className="chapters-order" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
            <div className="chapters-info"><div className="chapters-title"><strong>{chapter.title}</strong>{editing && <span>{dirty ? "编辑区有新修改" : "编辑中"}</span>}</div>
              <small>{metrics.scenes} 镜 · {duration(metrics.totalMs)} · {metrics.sharedAssets} 个同版本资产 · {metrics.sharedReferences} 个引用相同路径</small>
              <small className="chapters-saved">快照 {new Date(chapter.updatedAt).toLocaleString("zh-CN")} · 工程 {chapter.project.id}</small>
              {renaming === chapter.project.id && <form className="chapters-rename" onSubmit={event => { event.preventDefault(); if (!name.trim()) { setError("章节名称不能为空。"); return; } commit(chapters.map(item => item.project.id === chapter.project.id ? { ...item, title: name.trim() } : item), "章节已重命名；工程标题未改变。"); }}>
                <input autoFocus aria-label="章节新名称" value={name} maxLength={100} disabled={blocked} onChange={event => setName(event.target.value)} />
                <button type="submit" disabled={blocked || !name.trim()}>保存名称</button><button type="button" onClick={() => setRenaming(null)}>取消</button>
              </form>}
            </div>
            <div className="chapters-actions"><button type="button" disabled={blocked} onClick={() => propose({ kind: "open", chapter })}>载入编辑</button>
              <details><summary aria-label={`管理章节 ${chapter.title}`}>管理</summary><div className="chapters-manage">
                <button type="button" disabled={blocked || portable.hasPending()} onClick={() => { setRenaming(chapter.project.id); setName(chapter.title); setPending(null); }}>重命名</button>
                <button type="button" aria-label={`上移 ${chapter.title}`} disabled={blocked || index === 0} onClick={() => commit(moveChapter(chapters, chapter.project.id, -1), "已调整章节顺序；镜头顺序未改变。")}>上移</button>
                <button type="button" aria-label={`下移 ${chapter.title}`} disabled={blocked || index === chapters.length - 1} onClick={() => commit(moveChapter(chapters, chapter.project.id, 1), "已调整章节顺序；镜头顺序未改变。")}>下移</button>
                <button type="button" className="chapters-danger" onClick={() => propose({ kind: "remove", chapter })} disabled={blocked}>移除</button>
              </div></details>
            </div>
          </li>;
        })}</ol>
      </> : loaded && !readFailed && <div className="chapters-empty"><strong>还没有章节</strong><p>将当前工程加入列表，再载入另一份工程继续添加。每章独立编辑，不会拼接或渲染成片。</p></div>}
      {pending && <div className="chapters-confirm" role="group" aria-label="确认章节操作">
        <strong>{pending.kind === "open" ? `载入「${pending.chapter.title}」？` : pending.kind === "remove" ? `移除「${pending.chapter.title}」？` : pending.kind === "update" ? `更新「${pending.chapter.title}」快照？` : `添加 ${pending.chapters.length} 个章节？`}</strong>
        <p>{pending.kind === "open" ? project ? "当前可编辑工程会先保存到「全部作品」，再替换编辑区。未保存到章节的修改不会自动更新章节快照。" : "将这个章节载入编辑区；不会开始生成或渲染。" : pending.kind === "remove" ? "只移除本机章节快照，不删除当前编辑区、全部作品或素材文件。导出的 JSON 备份仍可重新导入。" : pending.kind === "update" ? "用编辑区的最新内容替换此章节快照；旧快照不保留，请按需先导出章节 JSON。" : pending.kind === "portable" ? "确认后将再次校验迁移包并写入素材库和本机章节；相同内容复用，冲突不会覆盖。" : "合并到本机章节列表，不覆盖同 ID 章节，不切换编辑区。引用 JSON 不包含素材文件。"}</p>
        {(pending.kind === "import" || pending.kind === "portable") && <ul>{pending.chapters.map(chapter => <li key={chapter.project.id}>{chapter.title} · {chapter.project.scenes.length} 镜</li>)}</ul>}
        <label><input type="checkbox" checked={consent} disabled={blocked} onChange={event => setConsent(event.target.checked)} />我确认以上操作</label>
        <div><button type="button" className="chapters-primary" disabled={blocked || !consent} onClick={confirm}>确认{pending.kind === "open" ? "载入" : pending.kind === "remove" ? "移除" : pending.kind === "update" ? "更新快照" : "添加章节"}</button><button type="button" disabled={portableBusy} onClick={() => { if (pending.kind === "portable") portable.cancel(); setPending(null); setConsent(false); setNotice(""); }}>取消操作</button></div>
      </div>}
      {error && <p role="alert" className="chapters-error">{error}</p>}{notice && <p role="status" className="chapters-notice">{notice}</p>}
      {readFailed && <button type="button" onClick={refresh}>重新读取本机章节</button>}
      <p className="chapters-footnote">章节自动写入此浏览器，不会云同步；编辑修改需手动「更新当前章节快照」。JSON 仅含工程、资料和素材引用，不含图片／视频文件。同版本资产只比较定义，相同路径不代表文件内容相同。网页内迁移不可用，可使用 Windows 桌面本机工具备份素材。</p>
  </div>;
}
