import { expect,it } from "vitest";
import { createProjectArchiveHost } from "./project-archive-host.mjs";
const snapshot={kind:"scene",project:{schemaVersion:1,id:"archive-host",title:"Archive",aspect:"16:9",knowledgeSources:[],scenes:[{id:"one",kind:"title",title:"One",narration:{text:"One",durationMs:1000}}]},documents:[]};
const library=()=>({async read(){throw Object.assign(new Error("missing"),{code:"ENOENT"});},async publish(){throw new Error("not expected");},async close(){}});
it("streams a native export, previews an import without writes, and returns one id on confirmation retry",async()=>{
 const host=createProjectArchiveHost({openStore:async()=>library()});
 try{
  const exported=await host.request({operation:"export",snapshot});
  const chunk=await host.request({operation:"read",token:exported.token,offset:0});
  await expect(host.request({operation:"read",token:"wrong",offset:0})).rejects.toThrow("过期");
  await host.request({operation:"cancel",token:exported.token});
  const started=await host.request({operation:"begin",bytes:exported.bytes});
  await expect(host.request({operation:"import",token:started.token,sha256:"fake"})).rejects.toThrow("预览");
  await expect(host.request({operation:"append",token:started.token,offset:1,base64:chunk.base64})).rejects.toThrow("顺序");
  await host.request({operation:"append",token:started.token,offset:0,base64:chunk.base64});
  const preview=await host.request({operation:"preview",token:started.token});expect(preview).toMatchObject({title:"Archive",assets:0,kind:"scene"});
  const imported=await host.request({operation:"import",token:started.token,sha256:preview.sha256});
  expect(imported.project.id).not.toBe(snapshot.project.id);
  expect(await host.request({operation:"import",token:started.token,sha256:preview.sha256})).toEqual(imported);
 }finally{await host.dispose();}
});
it("bounds memory, rejects invalid base64 and expired sessions, and never accepts caller filesystem paths",async()=>{
 let now=0;const host=createProjectArchiveHost({openStore:async()=>library(),now:()=>now});
 await expect(host.request({operation:"begin",bytes:33*1024*1024})).rejects.toThrow("32 MiB");
 const begun=await host.request({operation:"begin",bytes:10});
 await expect(host.request({operation:"begin",bytes:10})).rejects.toThrow("取消");
 await expect(host.request({operation:"append",token:begun.token,offset:0,base64:"@!"})).rejects.toThrow("编码");
 await expect(host.request({operation:"preview",token:begun.token})).rejects.toThrow("完整");
 now=600001;await expect(host.request({operation:"append",token:begun.token,offset:0,base64:"YQ=="})).rejects.toThrow("过期");
 await host.dispose();await expect(host.request({operation:"begin",bytes:1})).rejects.toThrow("关闭");
});
