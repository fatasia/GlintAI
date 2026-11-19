import { useEffect, useRef, useState } from "react";
import { useProjectGit } from "./project-git-controller";
import { gitFileLabel, gitSummary, gitTime, gitValue, type GitDiffFile, type ProjectGitProps } from "./project-git-client";
import "./project-git.css";
import { ProjectArchivePanel } from "./ProjectArchivePanel";
export type { ProjectGitProps as ProjectGitPanelProps } from "./project-git-client";
type Confirmation = { action: "copy" | "discard" | "delete" | "recover"; versions: string[]; signature: string };
function FileChanges({ files }: { files: GitDiffFile[] }) {
  if (!files.length) return <div className="pg-empty"><strong>没有文件差异</strong><p>编辑后点击「刷新改动」，再保存一个新版本。</p></div>;
  return <div className="pg-files" aria-label="文件改动明细">{files.map((file, index) => <details key={`${file.path}-${index}`}>
    <summary><span className={`pg-file-status is-${file.status.trim() === "D" ? "removed" : "changed"}`}>{gitFileLabel(file.status)}</span><span>{file.path}</span></summary>
    <div className="pg-diff"><section><h4>修改前</h4><pre tabIndex={0}>{gitValue(file.before)}</pre></section><section><h4>修改后</h4><pre tabIndex={0}>{gitValue(file.after)}</pre></section></div>
  </details>)}</div>;
}
export function ProjectGitPanel(props: ProjectGitProps) {
  const git = useProjectGit(props), panel = useRef<HTMLElement>(null);
  const [tab, setTab] = useState<"changes" | "history">("changes"), [query, setQuery] = useState(""), [filter, setFilter] = useState("all");
  const [checked, setChecked] = useState<string[]>([]), [pending, setPending] = useState<Confirmation | null>(null);
  const disabled = Boolean(git.busy) || !git.status || Boolean(git.review), selected = git.history.versions.find(item => item.id === git.selected);
  const versions = git.history.versions.filter(item => `${item.message} ${item.id} ${gitTime(item.at)}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())
    && (filter === "all" || filter === "current" && item.current || filter === "deleted" && item.deleted));
  const checkedItems = git.history.versions.filter(item => checked.includes(item.id));
  const propose = (action: Confirmation["action"], ids: string[] = []) => { if (!disabled) setPending({ action, versions: ids, signature: git.signature }); };
  useEffect(() => { setPending(null); }, [git.signature]);
  useEffect(() => { setChecked([]); setQuery(""); setFilter("all"); setTab("changes"); }, [props.project.id, props.kind]);
  useEffect(() => { setChecked(ids => ids.filter(id => git.history.versions.some(item => item.id === id))); }, [git.history.versions]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      if (git.busy) return;
      if (pending) setPending(null);
      else if (git.review) git.cancelReview();
      else props.onClose?.();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [pending, git.review, git.busy, props.onClose]);
  const confirm = () => {
    if (!pending || disabled) return;
    if (pending.action === "copy") void git.copy(pending.versions[0]!);
    else if (pending.action === "discard") void git.discard(pending.signature);
    else void git.hideVersions(pending.versions, pending.action === "recover");
    setPending(null);
  };
  const switchTab = (value: "changes" | "history") => { setTab(value); setPending(null); if (value === "changes" && git.diffMode !== "current" && !git.busy && !git.review) void git.inspect(); };
  const tabs = ["changes", "history"] as const;
  return <section ref={panel} className="project-git-panel" aria-label="Git 版本" aria-busy={Boolean(git.busy)}>
    <header className="pg-header"><div><h2>Git 版本</h2><p>本机版本记录，想保存时再保存。</p></div><div className="pg-actions">
      <span className="pg-local">仅本机 · 不推送</span>{props.onClose && <button type="button" aria-label="关闭 Git 版本" title={git.busy ? "请等待当前操作完成" : "关闭面板（Esc）"} disabled={Boolean(git.busy)} onClick={props.onClose}>关闭</button>}
    </div></header>
    <ProjectArchivePanel {...props} />
    {!git.available ? <div className="pg-empty"><strong>本地 Git 仅在桌面版可用</strong><p>请在 Glint 桌面版打开此工程。网页不会连接远程仓库或通过网络代替本地 Git。</p></div> : <>
      <div className="pg-overview"><span>当前版本 <code title={git.status?.current ?? "尚未保存"}>{git.status?.current?.slice(0, 8) ?? "尚未保存"}</code></span><span>{git.status?.versionCount ?? 0} 个版本</span><span>{git.status?.changedFiles.length ?? 0} 个文件有改动</span>
        <button type="button" disabled={Boolean(git.busy) || Boolean(git.review)} title={git.busy ? "请等待当前操作完成" : git.review ? "请先确认或取消恢复" : "捕获编辑区最新内容，读取本地 Git 状态"} onClick={() => void git.refresh()}>刷新改动</button></div>
      <div className="pg-tabs" role="tablist" aria-label="版本视图">{tabs.map((value, index) => <button key={value} id={`pg-tab-${value}`} type="button" role="tab" aria-selected={tab === value} aria-controls={`pg-view-${value}`} tabIndex={tab === value ? 0 : -1} onClick={() => switchTab(value)} onKeyDown={event => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault(); const next = tabs[1 - index]!; switchTab(next); panel.current?.querySelector<HTMLButtonElement>(`#pg-tab-${next}`)?.focus();
      }}>{value === "changes" ? "当前改动" : "历史版本"}</button>)}</div>
      {git.busy && <div className="pg-working" role="status"><span aria-hidden="true" />{git.busy}</div>}
      {!git.status && git.busy && <div className="pg-skeleton" aria-hidden="true"><span /><span /><span /></div>}
      {git.error && <div className="pg-error" role="alert"><p>{git.error}</p><button type="button" disabled={Boolean(git.busy) || Boolean(git.review)} title="只刷新状态，不会自动重试保存或创建副本" onClick={() => void git.refresh()}>重新读取版本</button></div>}
      {git.notice && <p className="pg-notice" role="status">{git.notice}</p>}
      {git.review && <section className="pg-confirm" aria-label="确认恢复版本"><h3>将版本 {git.review.label} 恢复到编辑区？</h3><p>「{git.review.snapshot.project.title}」 · {"scenes" in git.review.snapshot.project ? `${git.review.snapshot.project.scenes.length} 个镜头` : `${git.review.snapshot.project.tracks.length} 条轨道`} · {git.review.snapshot.documents?.length ?? 0} 份脚本 · {git.review.snapshot.workspace?.designs.documents.length ?? "未记录"} 份设计</p><p>{git.review.snapshot.workspace ? `固定品牌：${git.review.snapshot.workspace.brand?.name ?? "未固定（跟随工作室）"}；项目素材引用 ${git.review.snapshot.workspace.assets.length} 项。` : "此旧版本未记录设计、品牌和素材列表；恢复时保留当前这些数据，副本不继承未记录附件。"}</p><p>当前内容已保存为「恢复前保存」。确认后才替换编辑区；媒体文件仍使用原引用。本机 Git 恢复不代表共享服务端保存已确认，请另看共享工程同步状态。</p><div className="pg-actions"><button type="button" className="pg-primary" disabled={Boolean(git.busy)} onClick={git.applyReview}>确认恢复到编辑区</button><button type="button" disabled={Boolean(git.busy)} onClick={git.cancelReview}>保留当前编辑区</button></div></section>}
      {tab === "changes" ? <div role="tabpanel" id="pg-view-changes" aria-labelledby="pg-tab-changes" className="pg-content">
        {!git.fresh && git.status && <p className="pg-hint">编辑区有更新。保存会包含最新内容；查看最新差异请先刷新改动。</p>}
        <form className="pg-commit" onSubmit={event => { event.preventDefault(); if (!disabled) void git.commit(); }}>
          <label htmlFor="pg-version-name">版本名称<input id="pg-version-name" value={git.message} maxLength={500} placeholder="例如：调整开场节奏（留空使用当前时间）" disabled={Boolean(git.busy)} onChange={event => git.setMessage(event.target.value)} onKeyDown={event => { if (event.key === "Enter") event.preventDefault(); }} /></label>
          <button type="submit" className="pg-primary" disabled={disabled} title={git.review ? "先完成或取消恢复" : git.busy ? "请等待当前操作完成" : !git.status ? "请先读取本地 Git 状态" : "将当前工程和文档保存为一个 Git 提交"}>保存版本</button>
        </form>
        <div className="pg-section-head"><h3>未保存的文件改动</h3><button type="button" className="pg-danger" disabled={disabled || !git.fresh || !git.status?.current || !git.status.changedFiles.length} title={!git.fresh ? "先刷新最新改动再放弃" : !git.status?.current ? "还没有可还原的 Git 版本" : !git.status.changedFiles.length ? "没有可放弃的改动" : "明确确认后还原到当前 Git 版本"} onClick={() => propose("discard")}>放弃当前改动</button></div>
        {git.status && <FileChanges files={git.diffMode === "current" ? git.files : []} />}
      </div> : <div role="tabpanel" id="pg-view-history" aria-labelledby="pg-tab-history" className="pg-content">
        <div className="pg-filters"><label>搜索版本<input type="search" value={query} placeholder="名称、提交编号或时间" onChange={event => setQuery(event.target.value)} /></label><label>筛选<select value={filter} onChange={event => setFilter(event.target.value)}><option value="all">全部已加载版本</option><option value="current">当前版本</option>{git.includeDeleted && <option value="deleted">已删除版本</option>}</select></label><label className="pg-check"><input type="checkbox" checked={git.includeDeleted} disabled={disabled} title={disabled ? "等待当前操作完成并读取版本" : "包含已隐藏的 Git 版本"} onChange={event => { if (!event.target.checked) setFilter("all"); void git.toggleDeleted(event.target.checked); }} />显示已删除（{git.history.deletedCount}）</label></div>
        {checkedItems.length > 0 && <div className="pg-batch"><span>已选 {checkedItems.length} 个版本</span><button type="button" disabled={disabled || checkedItems.every(item => item.deleted || item.current)} onClick={() => propose("delete", checkedItems.filter(item => !item.deleted && !item.current).map(item => item.id))}>删除所选版本</button><button type="button" disabled={disabled || checkedItems.every(item => !item.deleted)} onClick={() => propose("recover", checkedItems.filter(item => item.deleted).map(item => item.id))}>找回所选版本</button></div>}
        <ol className="pg-history" aria-label="历史版本列表">{versions.map(version => <li key={version.id} className={version.id === git.selected ? "is-selected" : ""}>
          <input type="checkbox" aria-label={`选择版本 ${version.message}`} checked={checked.includes(version.id)} disabled={disabled} onChange={event => setChecked(ids => event.target.checked ? [...ids, version.id] : ids.filter(id => id !== version.id))} />
          <button type="button" className="pg-version" disabled={disabled} aria-pressed={version.id === git.selected} onClick={() => void git.inspect(version.id)}><strong>{version.message || "未命名版本"}</strong><small><time dateTime={new Date(version.at).toISOString()}>{gitTime(version.at)}</time> · {version.id.slice(0, 8)}</small></button>
          <div className="pg-version-meta">{version.current && <span className="pg-badge">当前</span>}{version.deleted && <span className="pg-badge is-deleted">已删除</span>}<button type="button" disabled={disabled || version.current && !version.deleted} title={version.current && !version.deleted ? "当前版本不能删除" : version.deleted ? "只找回列表记录，不切换工程" : "只从列表隐藏，可找回"} onClick={() => propose(version.deleted ? "recover" : "delete", [version.id])}>{version.deleted ? "找回" : "删除"}</button></div>
        </li>)}</ol>
        {!versions.length && git.status && <div className="pg-empty"><strong>{query || filter !== "all" ? "没有匹配的版本" : "还没有历史版本"}</strong><p>{query || filter !== "all" ? "调整搜索或筛选条件；也可以继续加载更早版本。" : "在「当前改动」中保存第一个版本，随后可比较、恢复或复制。"}</p></div>}
        {git.history.more && <button type="button" disabled={disabled} onClick={() => void git.loadMore()}>加载更早版本</button>}
        {selected && <section className="pg-preview" aria-label="选中版本预览"><div className="pg-section-head"><div><h3>{selected.message || "未命名版本"}</h3><p>{gitTime(selected.at)} · {selected.id.slice(0, 8)}</p></div><span className="pg-local">结构摘要 · 非视频预览</span></div>
          <div className="pg-actions"><button type="button" aria-pressed={git.diffMode === "parent"} disabled={disabled} onClick={() => void git.inspect(selected.id)}>与父版本比较</button><button type="button" aria-pressed={git.diffMode === "current"} disabled={disabled} onClick={() => void git.inspect()}>查看当前未保存改动</button></div>
          <p className="pg-hint">{git.diffMode === "parent" ? `所选版本相对${selected.parent ? `父版本 ${selected.parent.slice(0, 8)}` : "空工程"}的变化。` : "当前编辑区相对当前 Git 版本的未保存变化，不是所选历史版本的内容。"}</p><p className="pg-summary">{gitSummary(git.files)}</p>
          <FileChanges files={git.files} />
          <div className="pg-actions"><button type="button" disabled={disabled || selected.current || selected.deleted} title={selected.current ? "已经是当前版本" : selected.deleted ? "先找回此版本" : "先提交「恢复前保存」，再读取目标版本供你确认"} onClick={() => void git.restore(selected.id)}>恢复此版本</button><button type="button" disabled={disabled || !props.onCopy} title={!props.onCopy ? "此编辑器暂不支持接收副本" : "创建独立工程，不替换原工程"} onClick={() => propose("copy", [selected.id])}>复制为新工程</button></div>
        </section>}
      </div>}
      {pending && <section className="pg-confirm" aria-label="确认 Git 操作"><h3>{pending.action === "discard" ? "放弃当前未保存改动？" : pending.action === "copy" ? "复制为一个新工程？" : pending.action === "recover" ? `找回 ${pending.versions.length} 个版本？` : `删除 ${pending.versions.length} 个版本记录？`}</h3><p>{pending.action === "discard" ? "编辑区和文档将回到当前 Git 版本，未保存的修改无法找回。媒体原文件不会删除。" : pending.action === "copy" ? "使用选中版本创建独立编号的工程副本，保留原工程；媒体文件共用引用，不会重复复制。" : pending.action === "recover" ? "重新显示这些版本，不切换当前工程。" : "仅隐藏版本记录，不删除 Git 提交或媒体；可勾选「显示已删除」随时找回。"}</p><div className="pg-actions"><button type="button" disabled={disabled} className={pending.action === "discard" || pending.action === "delete" ? "pg-danger" : ""} onClick={confirm}>{pending.action === "discard" ? "确认放弃改动" : pending.action === "copy" ? "确认创建副本" : pending.action === "recover" ? "确认找回版本" : "确认删除记录"}</button><button type="button" disabled={Boolean(git.busy)} onClick={() => setPending(null)}>取消操作</button></div></section>}
      <footer className="pg-footnote">工程 JSON、脚本、设计 HTML（含内嵌图片）、批注、固定品牌与素材引用纳入本机 Git；共享素材原文件不备份、不回滚，缺失时需从素材备份补回。旧版未记录的附件不会清空当前数据。只在明确点击「保存版本」或「恢复此版本」时提交；不读取凭据，不连接远程仓库。</footer>
    </>}
  </section>;
}
export default ProjectGitPanel;
