import "./project-git.css";
import { useEffect, useRef, useState } from "react";
import { isLocalAgentAvailable, localAgentRequest } from "./local-agent-client";
import { assertAuthoringCanLeave } from "./authoring-leave";
import { captureGit, gitSignature, readGitSnapshot, type ProjectGitProps } from "./project-git-client";

const LIMIT=32*1024*1024,CHUNK=512*1024;
type Preview={sha256:string;kind:"scene"|"nle";title:string;assets:number;bytes:number};
const request=<T,>(operation:string,payload:Record<string,unknown>={})=>localAgentRequest<T>({action:"archive",operation,...payload});
const base64=(bytes:Uint8Array)=>{let value="";for(const byte of bytes)value+=String.fromCharCode(byte);return btoa(value);};
const decode=(value:string)=>Uint8Array.from(atob(value),char=>char.charCodeAt(0));
export function ProjectArchivePanel(props:ProjectGitProps){
 const [busy,setBusy]=useState(""),[error,setError]=useState(""),[preview,setPreview]=useState<Preview|null>(null),[consent,setConsent]=useState(false);
 const input=useRef<HTMLInputElement>(null),token=useRef(""),guard=useRef(""),lock=useRef(false),alive=useRef(true),latest=useRef(props);latest.current=props;
 const signature=()=>{const value=latest.current;return JSON.stringify([gitSignature(value.project,value.documents,value.getWorkspace?.()??value.workspace),value.getStorageSignature?.()??null]);};
 const cancel=async()=>{const current=token.current;if(current){await request("cancel",{token:current});if(token.current===current)token.current="";}};
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;void cancel().catch(()=>{});};},[]);
 const run=async(label:string,work:()=>Promise<void>)=>{
  if(lock.current)return;lock.current=true;setBusy(label);setError("");
  try{await work();}catch(cause){if(alive.current)setError(cause instanceof Error?cause.message:"工程包操作失败，请重试。");}
  finally{lock.current=false;if(alive.current)setBusy("");}
 };
 const exportArchive=()=>run("正在校验并打包素材…",async()=>{
  assertAuthoringCanLeave([props.project.id]);const before=signature();await cancel();
  const workspace=props.getWorkspace?.()??props.workspace;
  const snapshot=captureGit({kind:props.kind,project:props.project,documents:props.documents??[],...(workspace?{workspace}:{})});
  const result=await request<{token:string;bytes:number}>("export",{snapshot});token.current=result.token;
  if(!Number.isSafeInteger(result.bytes)||result.bytes<1||result.bytes>LIMIT)throw new Error("工程包大小无效。");
  const parts:Uint8Array[]=[];let offset=0;
  while(offset<result.bytes){const chunk=await request<{offset:number;base64:string}>("read",{token:token.current,offset});const bytes=decode(chunk.base64);if(chunk.offset!==offset||!bytes.length||bytes.length>CHUNK||offset+bytes.length>result.bytes)throw new Error("工程包传输不完整。");parts.push(bytes);offset+=bytes.length;}
  if(!alive.current)return;
  if(signature()!==before)throw new Error("打包期间工程发生变化，请重新导出最新版本。");
  const url=URL.createObjectURL(new Blob(parts as BlobPart[],{type:"application/zip"}));const link=document.createElement("a");link.href=url;link.download=`glint-${props.project.id}.zip`;link.click();setTimeout(()=>URL.revokeObjectURL(url),30000);await cancel();
 });
 const choose=(file:File)=>run("正在检查工程包…",async()=>{
  if(file.size<1||file.size>LIMIT)throw new Error("请选择不超过 32 MiB 的工程 ZIP。");
  assertAuthoringCanLeave([props.project.id]);await cancel();setPreview(null);setConsent(false);guard.current=signature();
  const started=await request<{token:string}>("begin",{bytes:file.size});token.current=started.token;
  for(let offset=0;offset<file.size;offset+=CHUNK){const bytes=new Uint8Array(await file.slice(offset,offset+CHUNK).arrayBuffer());const result=await request<{offset:number}>("append",{token:token.current,offset,base64:base64(bytes)});if(result.offset!==offset+bytes.length)throw new Error("工程包传输顺序不一致。");}
  const result=await request<Preview>("preview",{token:token.current});
  if(!alive.current)return;
  if(result.kind!==props.kind)throw new Error("请在对应的视频或剪辑工程中导入此包。");
  if(!/^[a-f0-9]{64}$/.test(result.sha256)||!Number.isSafeInteger(result.assets)||typeof result.title!=="string")throw new Error("工程包预览无效。");
  setPreview(result);
 });
 const confirm=()=>run("正在恢复素材和独立工程…",async()=>{
  if(!preview||!consent||!props.onCopy)return;
  assertAuthoringCanLeave([props.project.id]);if(signature()!==guard.current)throw new Error("预检后当前工程发生变化，请取消后重新预检。");
  const response=await request("import",{token:token.current,sha256:preview.sha256});
  if(!alive.current)return;
  assertAuthoringCanLeave([props.project.id]);if(signature()!==guard.current)throw new Error("恢复期间当前工程发生变化；素材已保留，请核对后重试。");
  const result=readGitSnapshot(response,props.kind,props.project.id,true);
  if(props.onCopy(result.project,result.documents,result.workspace)===false)throw new Error("编辑器未接受工程，请核对本机存储后重试。");
  await cancel();if(alive.current){setPreview(null);setConsent(false);}
 });
 if(!isLocalAgentAvailable())return null;
 return <details className="pg-preview"><summary>整项目 ZIP · 包含素材</summary>
  <p className="pg-hint">保存工程、脚本、页面、画布和所用素材，最多 32 MiB。导入创建独立工程，同名不同内容的素材不会覆盖。</p>
  <div className="pg-actions"><button type="button" disabled={Boolean(busy)||Boolean(preview)} onClick={()=>void exportArchive()}>导出完整工程 ZIP</button><button type="button" disabled={Boolean(busy)||!props.onCopy||Boolean(preview)} onClick={()=>input.current?.click()}>导入工程 ZIP</button></div>
  <input ref={input} type="file" hidden accept=".zip,application/zip" aria-label="完整工程 ZIP 文件" onChange={event=>{const file=event.target.files?.[0];event.target.value="";if(file)void choose(file);}}/>
  {busy&&<p role="status">{busy}</p>}{error&&<p role="alert">{error}</p>}
  {preview&&<section aria-label="工程包导入预览"><strong>{preview.title}</strong><p>{preview.assets} 个素材 · {(preview.bytes/1024/1024).toFixed(1)} MiB</p><label><input type="checkbox" checked={consent} disabled={Boolean(busy)} onChange={event=>setConsent(event.target.checked)}/>确认导入为独立工程</label><div className="pg-actions"><button type="button" disabled={Boolean(busy)||!consent} onClick={()=>void confirm()}>确认恢复工程</button><button type="button" disabled={Boolean(busy)} onClick={()=>void run("取消中…",async()=>{await cancel();setPreview(null);setConsent(false);})}>取消导入</button></div></section>}
 </details>;
}
