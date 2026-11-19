import { expect,it } from "vitest";
import { readNlePair,recoverNleSave,saveNlePair,NLE_PROJECT_KEY,NLE_SESSION_KEY,type NleStorage } from "./nle-storage";
function store(){const data=new Map<string,string>();const storage:NleStorage={getItem:key=>data.get(key)??null,setItem:(key,value)=>{data.set(key,value);},removeItem:key=>{data.delete(key);}};return{data,storage};}
const original={project:'{"id":"original"}',session:'{"revision":0}'},next={project:'{"id":"next"}',session:'{"revision":1}'};
it("journals the active pair and its project-library record as one recoverable save",()=>{
 const {storage}=store(),key='glint.nle.record.v1:original';
 saveNlePair(storage,readNlePair(storage),original,{key,before:null,after:'first'});
 expect(storage.getItem(key)).toBe('first');
 const broken={...storage,setItem:(target:string,value:string)=>{if(target===key)throw new Error('disk');storage.setItem(target,value);}};
 expect(()=>saveNlePair(broken,original,next,{key,before:'first',after:'second'})).toThrow('disk');
 recoverNleSave(storage);expect(readNlePair(storage)).toEqual(original);expect(storage.getItem(key)).toBe('first');
});
it("refuses foreign library bytes and arbitrary keys before starting a transaction",()=>{
 const {storage,data}=store(),key='glint.nle.record.v1:original';storage.setItem(key,'foreign');const before=[...data];
 expect(()=>saveNlePair(storage,readNlePair(storage),original,{key,before:null,after:'next'})).toThrow('其他窗口');
 expect(()=>saveNlePair(storage,readNlePair(storage),original,{key:'glint.workspace',before:null,after:'next'})).toThrow('键');
 expect([...data]).toEqual(before);
});
it("writes both records and refuses a foreign window without changing its bytes",()=>{
 const {data,storage}=store();saveNlePair(storage,readNlePair(storage),original);expect(readNlePair(storage)).toEqual(original);expect(data.has('glint.nle.save.v1')).toBe(false);
 storage.setItem(NLE_PROJECT_KEY,'foreign');expect(()=>saveNlePair(storage,original,next)).toThrow("其他窗口");expect(storage.getItem(NLE_PROJECT_KEY)).toBe('foreign');
});
it("rolls a partial interrupted save back before mounting the editor",()=>{
 const {storage}=store();saveNlePair(storage,readNlePair(storage),original);
 const broken={...storage,setItem:(key:string,value:string)=>{if(key===NLE_SESSION_KEY)throw new Error('disk');storage.setItem(key,value);}};
 expect(()=>saveNlePair(broken,original,next)).toThrow('disk');expect(storage.getItem(NLE_PROJECT_KEY)).toBe(next.project);
 recoverNleSave(storage);expect(readNlePair(storage)).toEqual(original);
});
it("preserves a committed pair when journal cleanup fails",()=>{
 const {storage}=store();saveNlePair(storage,readNlePair(storage),original);
 expect(()=>saveNlePair({...storage,removeItem:()=>{}},original,next)).toThrow("尚未清理");
 recoverNleSave(storage);expect(readNlePair(storage)).toEqual(next);
});
it("preserves corrupt and foreign journals without writing or deleting data",()=>{
 const {storage,data}=store();storage.setItem('glint.nle.save.v1','broken');const before=[...data];
 expect(()=>recoverNleSave(storage)).toThrow("损坏");expect([...data]).toEqual(before);
 storage.setItem('glint.nle.save.v1',JSON.stringify({version:1,committed:false,before:original,after:next}));storage.setItem(NLE_PROJECT_KEY,'foreign');
 expect(()=>recoverNleSave(storage)).toThrow("其他窗口");expect(storage.getItem(NLE_PROJECT_KEY)).toBe('foreign');
});

it("saves the full supported 200-character Unicode identity in the library",()=>{
 const {storage}=store(),key='glint.nle.record.v1:'+encodeURIComponent('剪'.repeat(200));
 saveNlePair(storage,readNlePair(storage),original,{key,before:null,after:'record'});
 expect(storage.getItem(key)).toBe('record');recoverNleSave(storage);
});
