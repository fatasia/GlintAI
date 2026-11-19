// @vitest-environment jsdom
import {expect,it} from "vitest";
import {parseProject} from "@glintai/scenescript";
import {createDesignDocument} from "./design-artifacts";
import {appendDesignSlides} from "./design-to-video";
const project=()=>parseProject({schemaVersion:1,id:"project",title:"Video",aspect:"16:9",knowledgeSources:[],scenes:[{id:"first",kind:"title",title:"Original",narration:{text:"Original narration"}}]});
it("appends each slide to the same editable project in order, preserves notes and theme without mutating source",()=>{
 const input=project(),doc=createDesignDocument("slides","Deck");doc.pages[0]!.notes="第一段旁白";
 const before=JSON.stringify([input,doc]);
 const next=appendDesignSlides(input,doc,{id:"slides-test",theme:{"--ink-2":"#121212","--paper":"#ffffff"}});
 expect(next.id).toBe(input.id);expect(next.scenes).toHaveLength(4);expect(next.scenes[0]).toEqual(input.scenes[0]);
 expect(next.scenes[1]).toMatchObject({kind:"html",presentation:"slide",id:"slides-test-1",narration:{text:"第一段旁白"}});
 expect(next.scenes[2]!.narration.text).toBe(doc.pages[1]!.title);
 expect(next.scenes[1]!.kind==="html" && next.scenes[1]!.html).toContain("--ink-2:#121212");
 expect(JSON.stringify([input,doc])).toBe(before);
});
it("refuses frozen projects, duplicate ids and dynamic content instead of exporting a misleading still",()=>{
 const input=project(),doc=createDesignDocument("slides");
 expect(()=>appendDesignSlides({...input,frozen:true},doc,{id:"x"})).toThrow("冻结");
 const next=appendDesignSlides(input,doc,{id:"x"});expect(()=>appendDesignSlides(next,doc,{id:"x"})).toThrow("冲突");
 doc.pages[0]!.html+="<script>document.body.textContent='dynamic'</script>";
 expect(()=>appendDesignSlides(input,doc,{id:"x"})).toThrow("脚本");
});
it("keeps brand overrides after the captured UI theme",()=>{
 const next=appendDesignSlides(project(),createDesignDocument("slides"),{id:"x",theme:{"--accent":"red"},brand:{name:"Brand",accent:"#123456",bg:"#ffffff",text:"#111111"}});
 const scene=next.scenes[1]!;if(scene.kind!=="html")throw Error();
 expect(scene.html.indexOf("--accent:red")).toBeLessThan(scene.html.indexOf("--accent:#123456"));
});

it("does not force tall slide content into a clipping viewport",()=>{
 const doc=createDesignDocument("slides");doc.pages[0]!.html='<main style="height:1000px">Long content<footer>Keep this footer</footer></main>';
 const scene=appendDesignSlides(project(),doc,{id:"tall"}).scenes[1]!;
 if(scene.kind!=="html")throw Error("fixture");
 expect(scene.html).toContain("min-height:720px");expect(scene.html).not.toContain("overflow:hidden");expect(scene.html).toContain("Keep this footer");
});
