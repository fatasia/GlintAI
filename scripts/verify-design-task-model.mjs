/** Explicit paid-provider check of the same durable multi-page runner used by the UI. */
import fs from 'node:fs/promises';import path from 'node:path';import {JSDOM}from'jsdom';
import {llmFromEnvironment}from'../packages/llm/src/index.ts';import{proposeArtifact}from'../apps/web/server/artifact-proposal.mjs';import{advanceDesignTask,parseDesignTask,taskDocument}from'../apps/web/src/design-task.ts';
const windows=[];globalThis.DOMParser=class{parseFromString(html){const dom=new JSDOM(html);windows.push(dom.window);return dom.window.document;}};
const out=process.env.GLINT_DESIGN_MODEL_OUT;if(!out||!path.isAbsolute(out))throw new Error('Set an absolute GLINT_DESIGN_MODEL_OUT');await fs.mkdir(out,{recursive:true});
const file=path.join(out,'checkpoint.json');let task;
try{task=parseDesignTask(await fs.readFile(file,'utf8'),'live-batch');}catch(error){if(error.code!=='ENOENT')throw error;task={version:1,id:'task-live-batch',projectId:'live-batch',brief:'生成一套社区图书交换活动介绍。已知资料：居民读完的书常闲置；邻居可在周末自带书交换；先试办一次，再收集参与者反馈决定下一次时间。没有报名人数、预算或满意度数据，不要编造。目的：向邻居说明为什么参与、如何参与、活动后如何反馈。克制白底深绿色中文排版。',kind:'slides',count:3,plan:null,pages:[]};}
const provider=llmFromEnvironment(),report={model:process.env.GLINT_LLM_MODEL,startedAt:new Date().toISOString(),calls:[],complete:false};
try{while(!task.plan||task.pages.length<task.count){const step=task.plan?`page-${task.pages.length+1}`:'plan',started=performance.now();task=await advanceDesignTask(task,async(document,instruction,signal)=>{const result=await proposeArtifact({document,instruction},{chat:async request=>{const response=await provider.chat(request);await fs.writeFile(path.join(out,`${step}.response.txt`),response.text);return response;}},{signal});return result.document;},AbortSignal.timeout(90000));await fs.writeFile(file,JSON.stringify(task,null,2));report.calls.push({step,elapsedMs:performance.now()-started,validated:true});await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));}
 const document=taskDocument(task);await fs.writeFile(path.join(out,'document.json'),JSON.stringify(document,null,2));
 for(const[index,page]of document.pages.entries()){await fs.writeFile(path.join(out,`slide-${index+1}.json`),JSON.stringify({document:{...document,pages:[page],activePageId:page.id}},null,2));await fs.writeFile(path.join(out,`slide-${index+1}.html`),page.html);}
 report.complete=true;report.pages=document.pages.length;report.notes=document.pages.map(page=>Boolean(page.notes?.trim()));
}catch(error){report.error=String(error).replaceAll(process.env.GLINT_LLM_API_KEY??'__missing__','[redacted]');process.exitCode=1;}
finally{for(const window of windows)window.close();await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
