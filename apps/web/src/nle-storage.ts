export type NleStorage = Pick<Storage,"getItem"|"setItem"|"removeItem">;
export const NLE_PROJECT_KEY="glint.nle.project.v2",NLE_SESSION_KEY="glint.nle.session.v1";
const JOURNAL="glint.nle.save.v1";
const KEYS=[NLE_PROJECT_KEY,NLE_SESSION_KEY] as const;
export type NleLibraryWrite={key:string;before:string|null;after:string};
const libraryKey=(key:string)=>/^glint\.nle\.record\.v1:[A-Za-z0-9%_.~-]{1,1800}$/.test(key);
export type NleStoredPair={project:string|null;session:string|null};
const entries=(value:NleStoredPair)=>[value.project,value.session];
const assign=(storage:NleStorage,key:string,value:string|null)=>value===null?storage.removeItem(key):storage.setItem(key,value);
export function readNlePair(storage:NleStorage):NleStoredPair{return{project:storage.getItem(KEYS[0]),session:storage.getItem(KEYS[1])};}
function recoverLibrarySave(storage:NleStorage,raw:string):boolean {
 const value=JSON.parse(raw);if(value.version!==2)return false;
 if(Object.keys(value).sort().join(',')!=="committed,entries,version"||typeof value.committed!=="boolean"||!Array.isArray(value.entries)||value.entries.length!==3)throw new Error("剪辑工程库日志格式无效。");
 const list=value.entries as Array<{key:string;before:string|null;after:string}>;
 if(list.some((entry,i)=>!entry||Object.keys(entry).sort().join(',')!=="after,before,key"||typeof entry.after!=="string"||(entry.before!==null&&typeof entry.before!=="string")||(i<2?entry.key!==KEYS[i]:!libraryKey(entry.key))))throw new Error("剪辑工程库日志键无效。");
 if(!value.committed){
  for(const entry of list)if(![entry.before,entry.after].includes(storage.getItem(entry.key)))throw new Error("其他窗口更新了剪辑工程库，未覆盖。");
  for(const entry of [...list].reverse()){
   if(storage.getItem(JOURNAL)!==raw||![entry.before,entry.after].includes(storage.getItem(entry.key)))throw new Error("剪辑工程库回退发生冲突。");
   assign(storage,entry.key,entry.before);if(storage.getItem(entry.key)!==entry.before)throw new Error("剪辑工程库回退失败。");
  }
  if(list.some(entry=>storage.getItem(entry.key)!==entry.before))throw new Error("剪辑工程库回退期间发生并发修改。");
 }
 if(storage.getItem(JOURNAL)!==raw)throw new Error("剪辑工程库恢复日志已变化。");
 storage.removeItem(JOURNAL);if(storage.getItem(JOURNAL)!==null)throw new Error("剪辑工程库日志尚未清理。");return true;
}
export function recoverNleSave(storage:NleStorage):void{
 const raw=storage.getItem(JOURNAL);if(raw===null)return;
 if(raw.length>24*1024*1024)throw new Error("剪辑恢复日志过大，请先备份。");
 try {if(recoverLibrarySave(storage,raw))return;}catch(cause){throw new Error(cause instanceof SyntaxError?"剪辑恢复日志损坏，原记录保留。":cause instanceof Error?cause.message:"剪辑恢复日志损坏。");}
 let record:{version:1;committed:boolean;before:NleStoredPair;after:NleStoredPair};
 try{
  if(raw.length>24*1024*1024)throw new Error();record=JSON.parse(raw);
  if(record.version!==1||typeof record.committed!=="boolean"||Object.keys(record).sort().join(',')!=="after,before,committed,version")throw new Error();
  for(const pair of [record.before,record.after])if(!pair||Object.keys(pair).sort().join(',')!=="project,session"||entries(pair).some(item=>item!==null&&typeof item!=="string"))throw new Error();
 }catch{throw new Error("剪辑恢复日志损坏，原记录已保留；请先备份。");}
 if(!record.committed){
  const before=entries(record.before),after=entries(record.after);
  for(let i=0;i<KEYS.length;i++){const current=storage.getItem(KEYS[i]!);if(current!==before[i]&&current!==after[i])throw new Error("其他窗口更新了剪辑记录，未回退对方修改。");}
  for(let i=KEYS.length-1;i>=0;i--){
   if(storage.getItem(JOURNAL)!==raw)throw new Error("剪辑恢复日志已变化。");
   const current=storage.getItem(KEYS[i]!);if(current!==before[i]&&current!==after[i])throw new Error("回退期间其他窗口更新剪辑，日志已保留。");
   assign(storage,KEYS[i]!,before[i]!);if(storage.getItem(KEYS[i]!)!==before[i])throw new Error("剪辑恢复写入失败，日志已保留。");
  }
  if(KEYS.some((key,i)=>storage.getItem(key)!==before[i]))throw new Error("剪辑回退期间发生并发修改，日志已保留。");
 }
 if(storage.getItem(JOURNAL)!==raw)throw new Error("剪辑恢复日志已变化。");
 storage.removeItem(JOURNAL);if(storage.getItem(JOURNAL)!==null)throw new Error("剪辑恢复日志尚未清理，请先备份。");
}
export function saveNlePair(storage:NleStorage,expected:NleStoredPair,next:NleStoredPair,library?:NleLibraryWrite):void{
 if(library){
  if(!libraryKey(library.key))throw new Error("剪辑工程库键无效。");
  if(storage.getItem(JOURNAL)!==null)throw new Error("剪辑恢复日志待处理。");
  const list=[...KEYS.map((key,i)=>({key,before:entries(expected)[i]!,after:entries(next)[i]!})),library];
  if(list.some(entry=>entry.after===null||new TextEncoder().encode(entry.after).length>8*1024*1024))throw new Error("剪辑工程库记录过大，请导出备份。");
  if(list.some(entry=>storage.getItem(entry.key)!==entry.before))throw new Error("其他窗口已更新剪辑工程库，请先导出备份。");
  if(list.every(entry=>entry.before===entry.after))return;
  let raw=JSON.stringify({version:2,committed:false,entries:list});
  if(new TextEncoder().encode(raw).length>24*1024*1024)throw new Error("剪辑恢复日志过大，请精简历史或导出备份。");
  storage.setItem(JOURNAL,raw);if(storage.getItem(JOURNAL)!==raw)throw new Error("剪辑工程库日志保存失败。");
  for(const entry of list){
   if(storage.getItem(JOURNAL)!==raw||storage.getItem(entry.key)!==entry.before)throw new Error("保存期间剪辑工程库发生冲突。");
   assign(storage,entry.key,entry.after);if(storage.getItem(entry.key)!==entry.after)throw new Error("剪辑工程库写入失败。");
  }
  if(list.some(entry=>storage.getItem(entry.key)!==entry.after))throw new Error("剪辑工程库保存期间发生并发修改。");
  raw=JSON.stringify({version:2,committed:true,entries:list});storage.setItem(JOURNAL,raw);if(storage.getItem(JOURNAL)!==raw)throw new Error("剪辑工程库提交标记保存失败。");
  storage.removeItem(JOURNAL);if(storage.getItem(JOURNAL)!==null)throw new Error("剪辑已保存，日志尚未清理。");return;
 }
 if(storage.getItem(JOURNAL)!==null)throw new Error("剪辑恢复日志待处理，请备份后重新打开。");
 const before=entries(expected),after=entries(next);
 if(after.some(value=>value===null||new TextEncoder().encode(value).length>8*1024*1024))throw new Error("剪辑及撤销记录过大，请导出备份。");
 if(KEYS.some((key,i)=>storage.getItem(key)!==before[i]))throw new Error("其他窗口已更新剪辑；当前修改未覆盖对方，请先导出备份。");
 if(before.every((value,i)=>value===after[i]))return;
 let raw=JSON.stringify({version:1,committed:false,before:expected,after:next});
 storage.setItem(JOURNAL,raw);if(storage.getItem(JOURNAL)!==raw)throw new Error("剪辑恢复日志无法保存，未覆盖原记录。");
 for(let i=0;i<KEYS.length;i++){
  if(storage.getItem(JOURNAL)!==raw||storage.getItem(KEYS[i]!)!==before[i])throw new Error("保存期间剪辑记录变化，恢复日志已保留。");
  assign(storage,KEYS[i]!,after[i]!);if(storage.getItem(KEYS[i]!)!==after[i])throw new Error("剪辑保存未通过核对，恢复日志已保留。");
 }
 if(KEYS.some((key,i)=>storage.getItem(key)!==after[i]))throw new Error("剪辑保存期间发生并发修改，日志已保留。");
 raw=JSON.stringify({version:1,committed:true,before:expected,after:next});storage.setItem(JOURNAL,raw);
 if(storage.getItem(JOURNAL)!==raw)throw new Error("剪辑提交标记保存失败，恢复日志已保留。");
 storage.removeItem(JOURNAL);if(storage.getItem(JOURNAL)!==null)throw new Error("剪辑已保存，但恢复日志尚未清理。");
}
