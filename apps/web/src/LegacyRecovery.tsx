import { useState } from "react";
import { importLegacySnapshot, parseLegacySnapshot, previewLegacySnapshot, recoverLegacyImport, restoreLegacyBackup, RECOVERY_BACKUP, RECOVERY_JOURNAL, type LegacySnapshot, type RecoveryEntry } from "./legacy-recovery";
import { legacyRecordSummary } from "./legacy-recovery-preview";

export default function LegacyRecovery({ startupError = "" }: { startupError?: string }) {
  const [error, setError] = useState(startupError), [snapshot, setSnapshot] = useState<LegacySnapshot | null>(null);
  const [entries, setEntries] = useState<RecoveryEntry[]>([]), [confirmed, setConfirmed] = useState(false);
  const [done, setDone] = useState(false), [downloaded, setDownloaded] = useState(false), [backup, setBackup] = useState(() => {
    try { return localStorage.getItem(RECOVERY_BACKUP); } catch { return null; }
  });
  const [busy, setBusy] = useState(false);
  const [restored, setRestored] = useState(false);
  const run = (action: () => void) => { try { action(); setError(""); } catch (cause) { setError(cause instanceof Error ? cause.message : "恢复失败，请保留备份。"); } };
  const close = () => run(() => { recoverLegacyImport(localStorage); window.location.hash = ""; window.location.reload(); });
  return <main style={{maxWidth:900,margin:"40px auto",padding:24,display:"grid",gap:20}} aria-label="旧客户端数据恢复">
    <header><h1>旧客户端数据恢复</h1><p>按旧端口分别导入。导入前关闭其他 Glint 窗口；当前页不挂载编辑器，不会自动保存工程。</p></header>
    {error && <p role="alert">{error}</p>}
    <div style={{display:"flex",gap:12,flexWrap:"wrap"}}><button className="g-btn" type="button" onClick={close}>返回工作区</button><button className="g-btn" type="button" onClick={() => run(() => recoverLegacyImport(localStorage))}>重试中断恢复</button></div>
    {backup && <section style={{border:"1px solid var(--line-2)",padding:16,borderRadius:12}}><h2>导入前备份</h2><p>保留了导入涉及的原记录及导入值。下一次导入前，请下载此备份。</p>
      <button className="g-btn" type="button" onClick={() => run(() => { restoreLegacyBackup(localStorage); setRestored(true); setDone(true); })}>撤销这次导入</button>
      <button className="g-btn" type="button" onClick={() => run(() => {
        const url = URL.createObjectURL(new Blob([backup], {type:"application/json"}));
        const link = document.createElement("a"); link.href=url; link.download="glint-before-legacy-import.json"; link.click();
        setTimeout(() => URL.revokeObjectURL(url),1000); setDownloaded(true);
      })}>下载导入前备份</button>
      <button className="g-btn" type="button" disabled={!downloaded} onClick={() => run(() => {
        if (localStorage.getItem(RECOVERY_JOURNAL) !== null) throw new Error("中断恢复未完成，不能清理备份。");
        if (localStorage.getItem(RECOVERY_BACKUP) !== backup) throw new Error("备份已变化，请重新打开恢复页。");
        localStorage.removeItem(RECOVERY_BACKUP);
        if (localStorage.getItem(RECOVERY_BACKUP) !== null) throw new Error("备份未能清理。");
        setBackup(null); setDownloaded(false);
      })}>已下载，清理本机备份</button>
    </section>}
    {!done && <>
      <label>选择 origin-端口.json<input aria-label="旧客户端备份文件" type="file" accept=".json,application/json" disabled={busy} onChange={async event => {
        const file=event.target.files?.[0]; event.target.value=""; if(!file)return;
        setBusy(true); setConfirmed(false); setSnapshot(null); setEntries([]);
        try {
          if(file.size>4*1024*1024)throw new Error("恢复文件超过 4 MB。");
          const value=parseLegacySnapshot(await file.text());
          recoverLegacyImport(localStorage); setEntries(previewLegacySnapshot(value,localStorage));setSnapshot(value);setError("");
        } catch(cause) {setError(cause instanceof Error?cause.message:"备份读取失败。");}
        finally {setBusy(false);}
      }}/></label>
      {snapshot && <section><h2>{snapshot.origin}</h2><p>待写入 {entries.length} 条；其中 {entries.filter(entry=>entry.before!==null).length} 条将替换同名记录。其他记录不变。</p>
        <ul style={{maxHeight:400,overflow:"auto",overflowWrap:"anywhere",listStyle:"none",padding:0,display:"grid",gap:10}}>{entries.map(entry=><li key={entry.key} style={{border:"1px solid var(--line-2)",borderRadius:8,padding:12}}><strong>{entry.key}</strong><small style={{display:"block"}}>{entry.before===null?"新增":"替换，原值会备份"}</small><p style={{margin:"6px 0"}}>当前：{legacyRecordSummary(entry.before)}</p><p style={{margin:"6px 0"}}>备份：{legacyRecordSummary(entry.after)}</p></li>)}</ul>
        <label><input type="checkbox" checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/>我已关闭其他客户端，并确认用这一端口的记录替换上述同名记录</label>
        <p>此文件不包含素材原文件或 IndexedDB。导入后仍需检查素材是否可用；不同端口请分别核对，不自动混合。</p>
        <button className="g-btn" type="button" disabled={!confirmed||!!backup||!entries.length||busy} onClick={()=>run(()=>{
          try {importLegacySnapshot(entries,localStorage);setDone(true);}
          finally {setBackup(localStorage.getItem(RECOVERY_BACKUP));}
        })}>备份当前记录并导入</button>
      </section>}
    </>}
    {done && <p role="status">{restored ? "已还原到导入前。" : "导入已保存。"}返回工作区后将重新读取数据；请检查工程、剪辑和生成画布。</p>}
  </main>;
}
