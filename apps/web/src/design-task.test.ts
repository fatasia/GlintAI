// @vitest-environment jsdom
import {expect,it} from 'vitest';
import {advanceDesignTask,parseDesignTask,saveDesignTask,designTaskKey,taskDocument,type DesignTask,type DesignTaskPropose} from './design-task';
const fresh=():DesignTask=>({version:1,id:'task-test',projectId:'test',brief:'真实资料：本周举办三场阅读活动，目标为读者介绍预约方式。',kind:'slides',count:2,plan:null,pages:[]});
const plan={title:'读书活动介绍',style:'白底深绿文字，统一字体与间距',pages:[{title:'活动与目标',brief:'解释读书活动与受众'},{title:'预约步骤',brief:'说明预约途径，未知信息待补充'}]};
const provider:DesignTaskPropose=async(document)=>'content'in document?{...document,content:JSON.stringify(plan)}:{...document,pages:document.pages.map(page=>({...page,html:'<!doctype html><html><head></head><body><main data-design-id="main"><h1 data-design-id="title">读书活动介绍与预约方式</h1><p data-design-id="text">本周举办三场阅读活动，欢迎读者参与，详细安排待补充。</p></main></body></html>',notes:'本页说明阅读活动的基本信息。'}))};
it('checkpoints planning and each page, resumes without repeating completed calls',async()=>{
 localStorage.clear();let task=fresh(),raw:string|null=null,calls=0;
 const propose:DesignTaskPropose=async(...args)=>{calls++;return provider(...args);};
 raw=saveDesignTask(task,raw,localStorage);
 task=await advanceDesignTask(task,propose,new AbortController().signal);raw=saveDesignTask(task,raw,localStorage);
 task=await advanceDesignTask(task,propose,new AbortController().signal);raw=saveDesignTask(task,raw,localStorage);
 expect(calls).toBe(2);expect(task.pages).toHaveLength(1);
 task=parseDesignTask(localStorage.getItem(designTaskKey('test'))!,'test');
 task=await advanceDesignTask(task,propose,new AbortController().signal);saveDesignTask(task,raw,localStorage);
 expect(calls).toBe(3);expect(taskDocument(task).pages.map(page=>page.id)).toEqual(['task-test-page-1','task-test-page-2']);
 await advanceDesignTask(task,propose,new AbortController().signal);expect(calls).toBe(3);
});
it('keeps saved progress on provider failure or cancellation and rejects a foreign checkpoint',async()=>{
 localStorage.clear();const task={...fresh(),plan},raw=saveDesignTask(task,null,localStorage);
 await expect(advanceDesignTask(task,async()=>{throw new Error('network');},new AbortController().signal)).rejects.toThrow('network');
 expect(localStorage.getItem(designTaskKey('test'))).toBe(raw);
 const controller=new AbortController();controller.abort();let called=false;
 await expect(advanceDesignTask(task,async(...args)=>{called=true;return provider(...args);},controller.signal)).rejects.toThrow();expect(called).toBe(false);
 localStorage.setItem(designTaskKey('test'),'foreign');expect(()=>saveDesignTask(task,raw,localStorage)).toThrow('其他窗口');expect(localStorage.getItem(designTaskKey('test'))).toBe('foreign');
});
it('rejects malformed plans, corrupt identity and executable restored pages',async()=>{
 await expect(advanceDesignTask(fresh(),async doc=>({...doc,content:'{"pages":[]}'}) as any,new AbortController().signal)).rejects.toThrow('规划');
 let task=await advanceDesignTask({...fresh(),plan},provider,new AbortController().signal);
 expect(()=>parseDesignTask(JSON.stringify(task),'other')).toThrow('损坏');
 task={...task,pages:[{...task.pages[0]!,html:'<script>alert(1)</script><main data-design-id="main">Injected</main>'}]};
 expect(()=>parseDesignTask(JSON.stringify(task),'test')).toThrow();
});
