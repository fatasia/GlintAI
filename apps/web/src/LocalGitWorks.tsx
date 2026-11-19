import { useEffect, useState } from "react";
import { downloadText } from "./editor-model";
import { findLocalGitWorks, readLocalGitWork, type LocalGitSelection, type LocalGitWork } from "./git-local-works";
import { gitProjectKey, sameGitProject } from "./project-git-storage";

export function LocalGitWorks({ disabled, onSelect }: { disabled: boolean; onSelect(value: LocalGitSelection): void }) {
  const [works, setWorks] = useState<LocalGitWork[]>([]), [notice, setNotice] = useState("");
  const refresh = () => {
    try { const found = findLocalGitWorks(); setWorks(found.works); setNotice(found.notice); }
    catch (cause) { setNotice(cause instanceof Error ? cause.message : "无法读取本机工程，请检查存储权限。"); }
  };
  useEffect(refresh, []);
  return <section aria-label="待核对的本机 Git 工程">
    <p className="ws-note">这里列出未登记或与作品列表不同的本机主快照，含已删除入口的工程。查找不恢复版本、不改作品列表；附件是当前本机内容，素材文件须另行备份。</p>
    <button type="button" className="g-btn g-btn--sm" onClick={refresh}>刷新本机工程</button>
    {notice && <p role="status" className="ws-note">{notice}</p>}
    {!works.length && <p className="ws-note">没有待核对的本机主快照。</p>}
    <div className="ws-list">{works.map(work => <div key={work.id} className="ws-row">
      <div className="ws-row-title"><strong>{work.title}</strong> · <code className="ws-code">{work.id}</code></div>
      {work.error && <p className="ws-note">{work.error}</p>}
      <div className="ws-actions">
        {work.project && <button type="button" className="g-btn g-btn--sm" disabled={disabled} onClick={() => {
          try {
            const selected = readLocalGitWork(work.id);
            if (!sameGitProject(selected.project, work.project!)) throw new Error("本机主快照已变化，请刷新列表后核对。");
            onSelect(selected);
            setNotice(selected.warning);
          } catch (cause) { setNotice(cause instanceof Error ? cause.message : "本机版本尚未核对。"); }
        }}>核对此本机工程</button>}
        <button type="button" className="g-btn g-btn--sm" onClick={() => {
          try {
            const raw = localStorage.getItem(gitProjectKey(work.id));
            if (raw === null) throw new Error("主快照已不存在，请刷新列表。");
            downloadText("glint-local-main.json", raw, "application/json;charset=utf-8");
            setNotice("已发起主快照 JSON 下载；不含脚本、设计或素材文件。");
          } catch (cause) { setNotice(cause instanceof Error ? cause.message : "导出失败，请检查下载权限。"); }
        }}>导出主快照 JSON</button>
      </div>
    </div>)}</div>
  </section>;
}
