import { expect,it,beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { zipSync,unzipSync,strToU8 } from "fflate";
import { exportProjectArchive,inspectProjectArchive,importProjectArchive } from "./project-archive.mjs";
let png:Buffer;
beforeAll(()=>{png=execFileSync("ffmpeg",["-v","error","-f","lavfi","-i","color=red:s=16x16","-frames:v","1","-f","image2pipe","-vcodec","png","-"],{windowsHide:true});});
const project=()=>({schemaVersion:1,id:"archive-test",title:"完整工程",aspect:"16:9",knowledgeSources:[],scenes:[{id:"one",kind:"title",title:"开场",narration:{text:"旁白",durationMs:1000}}]});
const input=()=>({kind:"scene",project:project(),documents:[{id:"script",title:"脚本",content:"正文",kind:"script",updatedAt:1}],workspace:{version:1,projectId:"archive-test",designs:{version:1,projectId:"archive-test",activeId:"design",documents:[{id:"design",title:"页面",kind:"page",activePageId:"page",updatedAt:1,pages:[{id:"page",title:"封面",html:'<main><img src="/api/media/assets/cover.png"><h1>完整页面</h1></main>'}]}]},brand:null,assets:[{name:"cover.png",url:"/api/media/assets/cover.png",bytes:png.length}],board:{positions:{"scene:one":{x:20,y:30}}}}});
function store(seed:Map<string,Buffer>=new Map()){
 let publishes=0;
 return {seed,get publishes(){return publishes;},async read(name:string){const bytes=seed.get(name);if(!bytes)throw Object.assign(new Error("missing"),{code:"ENOENT"});return bytes;},async publish(name:string,bytes:Buffer){const previous=seed.get(name);if(previous&&!previous.equals(bytes))throw new Error("conflict");seed.set(name,bytes);publishes++;}};
}
it("exports and restores all project text, designs and real asset bytes into an independent project",async()=>{
 const source=store(new Map([["cover.png",png]])),target=store();
 const archive=await exportProjectArchive(input(),source);
 expect(Object.keys(unzipSync(archive)).sort()).toEqual(["assets/cover.png","manifest.json","project.json"]);
 const preview=await inspectProjectArchive(archive,target);expect(preview.value).toEqual(input());expect(target.publishes).toBe(0);
 const restored=await importProjectArchive(archive,target);expect(restored.project.id).not.toBe(project().id);
 expect(restored.workspace.projectId).toBe(restored.project.id);expect(restored.workspace.designs.projectId).toBe(restored.project.id);
 expect(restored.workspace.designs.documents).toEqual(input().workspace.designs.documents);expect(target.seed.get("cover.png")).toEqual(png);
 await importProjectArchive(archive,target);expect(target.seed.size).toBe(1);
});
it("rejects missing or conflicting media without publishing anything",async()=>{
 await expect(exportProjectArchive(input(),store())).rejects.toThrow();
 const archive=await exportProjectArchive(input(),store(new Map([["cover.png",png]])));
 const target=store(new Map([["cover.png",Buffer.from("different")]]));
 await expect(importProjectArchive(archive,target)).rejects.toThrow("不同");expect(target.publishes).toBe(0);
});
it("rejects traversal, unlisted files and tampered bytes before publication",async()=>{
 const archive=await exportProjectArchive(input(),store(new Map([["cover.png",png]])));
 for(const change of [
  (files:Record<string,Uint8Array>)=>{files["../outside.png"]=png;},
  (files:Record<string,Uint8Array>)=>{files["assets/unused.png"]=png;},
  (files:Record<string,Uint8Array>)=>{files["assets/cover.png"]=strToU8("broken");},
  (files:Record<string,Uint8Array>)=>{delete files["assets/cover.png"];},
  (files:Record<string,Uint8Array>)=>{files["project.json"]=strToU8("{}");},
 ]){const files=unzipSync(archive);change(files);const target=store();await expect(importProjectArchive(Buffer.from(zipSync(files)),target)).rejects.toThrow();expect(target.publishes).toBe(0);}
});
it("refuses remote dependencies and unsupported fields instead of exporting an incomplete project",async()=>{
 const value=input();value.workspace.designs.documents[0]!.pages[0]!.html='<img src="https://example.invalid/private.png">';
 await expect(exportProjectArchive(value,store())).rejects.toThrow("未托管");
 await expect(exportProjectArchive({...input(),secret:"unknown"},store())).rejects.toThrow();
});


it("packs a real NLE image track and restores an independent editable timeline",async()=>{
 const value={kind:"nle",project:{schemaVersion:1,id:"nle-archive",title:"剪辑完整包",fps:30,width:1920,height:1080,tracks:[{id:"visual",kind:"video",name:"画面",clips:[{id:"cover",kind:"image",src:"assets/cover.png",startMs:0,durationMs:1000}]}]},documents:[]};
 const source=store(new Map([["cover.png",png]])),target=store();
 const archive=await exportProjectArchive(value,source),preview=await inspectProjectArchive(archive,target);
 expect(preview.value.project.tracks[0].clips[0].src).toBe("assets/cover.png");
 const restored=await importProjectArchive(archive,target);
 expect(restored.project.id).not.toBe(value.project.id);expect(restored.project.tracks).toEqual(preview.value.project.tracks);
 expect(target.seed.get("cover.png")).toEqual(png);
});

it("packs media referenced only by the linked timeline and remaps both project identities on import",async()=>{
 const value=input() as any;
 value.workspace.timeline={project:{schemaVersion:1,id:value.project.id,title:"关联剪辑",fps:30,width:1920,height:1080,tracks:[{id:"visual",kind:"video",name:"画面",clips:[{id:"only",kind:"image",src:"assets/timeline-only.png",startMs:0,durationMs:1000}]}]},bridge:{sourceId:"saved-film",projectId:value.project.id,links:[]}};
 const source=store(new Map([["cover.png",png],["timeline-only.png",png]])),target=store();
 const archive=await exportProjectArchive(value,source);expect(Object.keys(unzipSync(archive))).toContain("assets/timeline-only.png");
 const restored=await importProjectArchive(archive,target);expect(restored.workspace.timeline.project.id).toBe(restored.project.id);expect(restored.workspace.timeline.bridge.projectId).toBe(restored.project.id);
 expect(restored.workspace.timeline.project.tracks).toEqual(value.workspace.timeline.project.tracks);expect(target.seed.get("timeline-only.png")).toEqual(png);
});
