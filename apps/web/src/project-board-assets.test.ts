import { expect,it } from "vitest";
import { parseProject } from "@glintai/scenescript";
import { boardAssets } from "./project-board-assets";
it("groups managed visual references by asset and reports actual scene usage",()=>{
 const project=parseProject({schemaVersion:1,id:"p",title:"P",aspect:"16:9",knowledgeSources:[],scenes:[{id:"a",kind:"image",src:"assets/cover.png",narration:{text:"A"}},{id:"b",kind:"image",src:"assets/cover.png",narration:{text:"B"}}]});
 expect(boardAssets(project,[{name:"cover.png",url:"/assets/cover.png"},{name:"remote.png",url:"https://example.com/remote.png"}])).toEqual([{name:"cover.png",url:"/api/media/assets/cover.png",kind:"image",usedBy:["a","b"]}]);
 expect(boardAssets(project,[{name:"bad.png",url:"/api/media/assets/../bad.png"}])).toHaveLength(1);
});
