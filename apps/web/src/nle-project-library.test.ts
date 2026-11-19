import { expect,it } from "vitest";
import { parseNleProject } from "@glintai/scenescript";
import { createNleSession } from "./nle-session";
import { nleRecordKey,parseNleRecord,serializeNleRecord,parseNleBridge } from "./nle-project-library";
const project=()=>parseNleProject({schemaVersion:1,id:"film-one",title:"剪辑",fps:30,width:1920,height:1080,tracks:[{id:"t",name:"Text",kind:"text",clips:[]}]});
it("persists and restores independent project history",()=>{
 const initial=project(),session=createNleSession(initial);
 expect(session.apply({...initial,title:"修改"},"改名").ok).toBe(true);
 const pair={project:JSON.stringify(session.document()),session:JSON.stringify(session.exportState())};
 const record=parseNleRecord(serializeNleRecord(pair,null),initial.id);
 const other=createNleSession({...initial,id:"different"});other.restore(JSON.parse(record.pair.session!));
 expect(other.document().title).toBe("修改");expect(other.undo()).toBe(true);expect(other.document().title).toBe("剪辑");
 expect(other.document().id).toBe(initial.id);
});
it("rejects mismatched history and foreign source associations",()=>{
 const initial=project(),session=createNleSession(initial),pair={project:JSON.stringify(initial),session:JSON.stringify({...session.exportState(),projectId:"other"})};
 expect(()=>serializeNleRecord(pair,null)).toThrow('身份');
 expect(()=>parseNleBridge({sourceId:"other",links:[]},initial.id)).toThrow('关联');
 expect(()=>parseNleRecord('{broken',initial.id)).toThrow();
 expect(nleRecordKey("a/b:中文")).toMatch(/^glint\.nle\.record\.v1:a%2Fb%3A/);
});
