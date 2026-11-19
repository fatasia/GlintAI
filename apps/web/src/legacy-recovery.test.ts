import { expect, it } from "vitest";
import { importLegacySnapshot, parseLegacySnapshot, previewLegacySnapshot, recoverLegacyImport, restoreLegacyBackup, RECOVERY_BACKUP, RECOVERY_JOURNAL, type RecoveryStorage } from "./legacy-recovery";
function memory(initial: Record<string,string>={}) {
  const values=new Map(Object.entries(initial));
  const storage:RecoveryStorage={getItem:key=>values.get(key)??null,setItem:(key,value)=>{values.set(key,value);},removeItem:key=>{values.delete(key);}};
  return {storage,values};
}
const raw=JSON.stringify({version:1,origin:"http://127.0.0.1:12345",exportedAt:"2026-11-01",values:{"glint.workspace":'{"title":"old"}',"glint:theme":"light"}});
it("previews exact conflicts and leaves unrelated records untouched",()=>{
  const {storage}=memory({"glint.workspace":'{"title":"current"}',"unrelated":"keep"});
  const plan=previewLegacySnapshot(parseLegacySnapshot(raw),storage);
  expect(plan).toHaveLength(2); expect(plan[0]!.before).toBe('{"title":"current"}');
  importLegacySnapshot(plan,storage);
  expect(storage.getItem("glint.workspace")).toBe('{"title":"old"}');
  expect(storage.getItem("unrelated")).toBe("keep");
  expect(storage.getItem(RECOVERY_JOURNAL)).toBeNull();
  expect(JSON.parse(storage.getItem(RECOVERY_BACKUP)!).entries).toEqual(plan);
});
it.each(["https://example.com","http://localhost:12345","http://127.0.0.1:80","http://127.0.0.1:99999"])("rejects unrelated origin %s",origin=>{
  expect(()=>parseLegacySnapshot(JSON.stringify({...JSON.parse(raw),origin}))).toThrow();
});
it("rejects credentials and invalid records without changing storage",()=>{
  expect(()=>parseLegacySnapshot(JSON.stringify({...JSON.parse(raw),values:{"glint:api-key":"secret"}}))).toThrow("未知");
  expect(()=>parseLegacySnapshot(JSON.stringify({...JSON.parse(raw),values:{"glint.workspace":"broken"}}))).toThrow("JSON");
});
it("rejects stale review before creating backup or writing data",()=>{
  const {storage}=memory();const plan=previewLegacySnapshot(parseLegacySnapshot(raw),storage);
  storage.setItem("glint.workspace",'{"title":"other"}');
  expect(()=>importLegacySnapshot(plan,storage)).toThrow("预检后");
  expect(storage.getItem(RECOVERY_BACKUP)).toBeNull();
  expect(storage.getItem("glint.workspace")).toBe('{"title":"other"}');
});
it("rolls back a partial write and keeps the pre-import backup",()=>{
  const {storage}=memory({"glint.workspace":'{"title":"before"}'});
  const plan=previewLegacySnapshot(parseLegacySnapshot(raw),storage),write=storage.setItem;
  storage.setItem=(key,value)=>{if(key==="glint:theme")throw new Error("quota");write(key,value);};
  expect(()=>importLegacySnapshot(plan,storage)).toThrow("quota");
  expect(storage.getItem("glint.workspace")).toBe('{"title":"before"}');
  expect(storage.getItem("glint:theme")).toBeNull();expect(storage.getItem(RECOVERY_JOURNAL)).toBeNull();
  expect(storage.getItem(RECOVERY_BACKUP)).not.toBeNull();
});
it("resumes rollback after a simulated process termination midway through writes",()=>{
  const {storage}=memory({"glint.workspace":'{"title":"before"}'});
  const entries=previewLegacySnapshot(parseLegacySnapshot(raw),storage);
  storage.setItem(RECOVERY_JOURNAL,JSON.stringify({version:1,state:"prepared",entries}));
  storage.setItem(entries[0]!.key,entries[0]!.after!);
  recoverLegacyImport(storage);
  expect(storage.getItem("glint.workspace")).toBe('{"title":"before"}');expect(storage.getItem("glint:theme")).toBeNull();
});
it("does not roll back a committed import after cleanup failure",()=>{
  const {storage}=memory();const entries=previewLegacySnapshot(parseLegacySnapshot(raw),storage);
  for(const entry of entries)storage.setItem(entry.key,entry.after!);
  storage.setItem(RECOVERY_JOURNAL,JSON.stringify({version:1,state:"committed",entries}));
  recoverLegacyImport(storage);expect(storage.getItem("glint:theme")).toBe("light");expect(storage.getItem(RECOVERY_JOURNAL)).toBeNull();
});
it("preserves a concurrent edit and pending log instead of blindly undoing it",()=>{
  const {storage}=memory();const entries=previewLegacySnapshot(parseLegacySnapshot(raw),storage);
  const journal=JSON.stringify({version:1,state:"prepared",entries});storage.setItem(RECOVERY_JOURNAL,journal);
  storage.setItem("glint.workspace",'{"title":"concurrent"}');
  expect(()=>recoverLegacyImport(storage)).toThrow("其他窗口");
  expect(storage.getItem("glint.workspace")).toBe('{"title":"concurrent"}');expect(storage.getItem(RECOVERY_JOURNAL)).toBe(journal);
});
it("does not replace a previous backup and detects silent failed writes",()=>{
  const {storage}=memory({[RECOVERY_BACKUP]:"prior"});
  expect(()=>importLegacySnapshot(previewLegacySnapshot(parseLegacySnapshot(raw),storage),storage)).toThrow("上一次");
  expect(storage.getItem(RECOVERY_BACKUP)).toBe("prior");
  storage.removeItem(RECOVERY_BACKUP);storage.setItem=()=>{};
  expect(()=>importLegacySnapshot(previewLegacySnapshot(parseLegacySnapshot(raw),storage),storage)).toThrow("核对");
  expect(storage.getItem("glint.workspace")).toBeNull();
});

it("undoes an import including newly created keys and retains backup",()=>{
 const {storage}=memory({"glint.workspace":'{"title":"before"}'});
 importLegacySnapshot(previewLegacySnapshot(parseLegacySnapshot(raw),storage),storage);
 restoreLegacyBackup(storage);
 expect(storage.getItem("glint.workspace")).toBe('{"title":"before"}');expect(storage.getItem("glint:theme")).toBeNull();
 expect(storage.getItem(RECOVERY_BACKUP)).not.toBeNull();
 restoreLegacyBackup(storage);expect(storage.getItem(RECOVERY_JOURNAL)).toBeNull();
});
it("refuses undo after a new edit rather than deleting it",()=>{
 const {storage}=memory();importLegacySnapshot(previewLegacySnapshot(parseLegacySnapshot(raw),storage),storage);
 storage.setItem("glint.workspace",'{"title":"new edit"}');
 expect(()=>restoreLegacyBackup(storage)).toThrow("新编辑");expect(storage.getItem("glint.workspace")).toBe('{"title":"new edit"}');
});
