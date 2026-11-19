import { expect,it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
// @ts-expect-error native service
import { startDesktopService } from "./desktop-service.mjs";
it.skipIf(process.platform!=="win32")("serves project archives only on native control, never the public HTTP surface",async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"glint-native-archive-"));
 const service=await startDesktopService({dataDir:root});
 try{
  const snapshot={kind:"scene",project:{schemaVersion:1,id:"native-archive",title:"本机工程",aspect:"16:9",knowledgeSources:[],scenes:[{id:"one",kind:"title",title:"开场",narration:{text:"原文",durationMs:1000}}]},documents:[]};
  const request=(operation:string,value={})=>service.agentRequest({action:"archive",operation,...value});
  const result=await request("export",{snapshot});expect(result).toMatchObject({bytes:expect.any(Number)});
  const chunk=await request("read",{token:result.token,offset:0});await request("cancel",{token:result.token});
  const upload=await request("begin",{bytes:result.bytes});await request("append",{token:upload.token,offset:0,base64:chunk.base64});
  const preview=await request("preview",{token:upload.token});expect(preview.title).toBe("本机工程");
  const restored=await request("import",{token:upload.token,sha256:preview.sha256});expect(restored.project.id).not.toBe("native-archive");
  const http=await fetch(service.url+'/api/project/archive',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({operation:'import',token:upload.token,sha256:preview.sha256})});expect(http.status).toBe(404);
 }finally{await service.close();const real=fs.realpathSync(root),temp=fs.realpathSync(os.tmpdir());if(path.dirname(real)!==temp||!path.basename(real).startsWith('glint-native-archive-'))throw new Error('Unsafe cleanup');fs.rmSync(real,{recursive:true,force:true});}
},30000);
