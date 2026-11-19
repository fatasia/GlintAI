import {useAuthoringLeaveGuard} from "./authoring-leave";
import {downloadJson} from "./editor-model";
import { useEffect, useRef, useState } from "react";
import { appFetch } from "./app-url";
import type { DesignDocument, DesignKind } from "./design-artifacts";
import { parseArtifactProject } from "./artifact-project";
import { advanceDesignTask,designTaskKey,parseDesignTask,saveDesignTask,taskDocument,type DesignTask,type DesignTaskPropose } from "./design-task";
import { DesignThumb } from "./design-editor-preview";
const propose:DesignTaskPropose=async(document,instruction,signal)=>{
 const response=await appFetch('/api/artifact/proposal',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({document,instruction}),signal:AbortSignal.any([signal,AbortSignal.timeout(75000)])});
 if(!response.ok)throw new Error(response.status===503?'请先配置文本模型。':'本步生成失败，可保留已完成页面后继续重试。');
 const raw=await response.text();if(raw.length>2200000)throw new Error('模型返回过大。');
 const value=JSON.parse(raw);return parseArtifactProject({schemaVersion:1,id:'design-task',title:'连续设计',document:value.document}).document;
};
export function DesignTaskPanel({projectId,onAdopt,onClose}:{projectId:string;onAdopt(document:DesignDocument):void;onClose():void}){
 const [brief,setBrief]=useState(''),[kind,setKind]=useState<DesignKind>('slides'),[count,setCount]=useState(3),[task,setTask]=useState<DesignTask|null>(null),[error,setError]=useState(''),[running,setRunning]=useState(false),[corrupt,setCorrupt]=useState(false),[unsaved,setUnsaved]=useState(false);
 const expected=useRef<string|null>(null),active=useRef<AbortController|null>(null),current=useRef<DesignTask|null>(null),alive=useRef(true);
 useEffect(()=>{alive.current=true;try{expected.current=localStorage.getItem(designTaskKey(projectId));if(expected.current){const saved=parseDesignTask(expected.current,projectId);current.current=saved;setTask(saved);}}catch(cause){setCorrupt(true);setError(cause instanceof Error?cause.message:'任务读取失败，原记录保留。');}return()=>{alive.current=false;active.current?.abort();};},[projectId]);
 const checkpoint=(next:DesignTask)=>{current.current=next;setTask(next);setUnsaved(true);const raw=saveDesignTask(next,expected.current,localStorage);expected.current=raw;setUnsaved(false);};
 useAuthoringLeaveGuard(projectId,()=>{if(unsaved)throw new Error('连续设计成果尚未保存，请重试保存或导出任务草稿。');});
 const close=()=>{if(unsaved){setError('当前成果尚未保存，请重试保存，或导出草稿后明确清除任务。');return;}onClose();};
 const run=async(start:DesignTask)=>{
  if(active.current)return;const controller=new AbortController();active.current=controller;setRunning(true);setError('');let next=start;
  try{checkpoint(next);while(!next.plan||next.pages.length<next.count){next=await advanceDesignTask(next,propose,controller.signal);controller.signal.throwIfAborted();checkpoint(next);}}
  catch(cause){if(alive.current)setError(controller.signal.aborted?'已暂停。完成的页面保留，继续时从未完成步骤开始。':cause instanceof Error?cause.message:'生成失败，请重试当前步骤。');}
  finally{if(active.current===controller){active.current=null;if(alive.current)setRunning(false);}}
 };
 const start=()=>{try{const next:DesignTask={version:1,id:`task-${crypto.randomUUID()}`,projectId,brief:brief.trim(),kind,count,plan:null,pages:[]};checkpoint(next);void run(next);}catch(cause){setError(cause instanceof Error?cause.message:'未能保存任务。');}};
 const complete=task?.pages.length===task?.count&&Boolean(task?.plan);
 return <section className="design-task-panel" aria-label="连续设计任务">
  <header><h2>从资料生成整稿</h2><button type="button" onClick={close}>收起任务</button></header>
  <p>先规划结构，再逐页生成并校验。每页完成后保存；关闭或重启会暂停，不会自动再次调用模型。确认后作为独立设计加入项目。</p>
  {!task&&!corrupt&&<><label>资料与要求<textarea aria-label="连续设计资料" maxLength={12000} rows={5} value={brief} onChange={event=>setBrief(event.target.value)} placeholder="粘贴资料，说明受众、目的和希望保留的信息。"/></label><div className="design-task-actions"><label>类型<select aria-label="连续设计类型" value={kind} onChange={event=>setKind(event.target.value as DesignKind)}><option value="slides">幻灯片</option><option value="page">多页网站</option><option value="prototype">应用界面</option></select></label><label>页数<input aria-label="连续设计页数" type="number" min={2} max={12} value={count} onChange={event=>setCount(Number(event.target.value))}/></label><button type="button" disabled={!brief.trim()||running} onClick={start}>规划并生成</button></div><small>会调用 1 次规划 + 每页 1 次生成；计费以配置的模型服务为准。</small></>}
  {task&&<><p role="status">{task.plan?.title??'正在规划内容'} · {task.pages.length} / {task.count} 页{running?' · 执行中':complete?' · 待确认':' · 已暂停'}</p>
   {task.plan&&<ol>{task.plan.pages.map((page,index)=><li key={index}>{page.title} · {index<task.pages.length?'已保存':'待生成'}</li>)}</ol>}
   <div className="design-task-previews">{task.pages.map(page=><article key={page.id}><strong>{page.title}</strong><DesignThumb html={page.html} title={`${page.title} 生成预览`} viewport={task.kind==='slides'?'slides':'desktop'}/></article>)}</div>
   <div className="design-task-actions">{running?<button type="button" onClick={()=>active.current?.abort()}>暂停任务</button>:!complete&&<button type="button" onClick={()=>void run(current.current!)}>继续未完成步骤</button>}
   <button type="button" disabled={running||!complete||unsaved} onClick={()=>{try{if(localStorage.getItem(designTaskKey(projectId))!==expected.current)throw new Error('其他窗口已更新任务，请重新打开核对。');onAdopt(taskDocument(parseDesignTask(JSON.stringify(task),projectId)));}catch(cause){setError(cause instanceof Error?cause.message:'加入项目失败，生成结果保留。');}}}>确认加入项目</button>
   {!running&&<button type="button" onClick={()=>{if(!confirm('清除本任务的规划和生成草稿？已加入项目的文档不受影响。'))return;try{if(localStorage.getItem(designTaskKey(projectId))!==expected.current)throw new Error('任务已被其他窗口修改，未清除。');localStorage.removeItem(designTaskKey(projectId));if(localStorage.getItem(designTaskKey(projectId))!==null)throw new Error('任务未能清除。');expected.current=null;current.current=null;setTask(null);setUnsaved(false);setError('');}catch(cause){setError(String(cause));}}}>清除任务草稿</button>}</div></>}
  {task&&<div className="design-task-actions"><button type="button" onClick={()=>downloadJson(`${task.id}.design-task.json`,task)}>导出任务草稿</button>{unsaved&&<button type="button" onClick={()=>{try{checkpoint(current.current!);setError('');}catch(cause){setError(cause instanceof Error?cause.message:'保存失败，请先导出任务草稿。');}}}>重试保存当前成果</button>}</div>}
  {unsaved&&<p role="alert">当前成果只在窗口中，尚未写入本机。不要关闭客户端；重试保存不会重新调用模型。</p>}
  {error&&<p role="alert">{error}</p>}
 </section>;
}
