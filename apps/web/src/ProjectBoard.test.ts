// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ProjectBoard, projectBoardItems } from "./ProjectBoard";
import { parseProject } from "@glintai/scenescript";
import type { ProjectDocuments } from "./script-documents";
import type { ProjectDesignDocuments } from "./design-artifacts";
vi.mock("./GenerationSurface", () => ({ GenerationSurface: () => null }));
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
it("references actual scenes, scripts and design pages without copying or mutating them", () => {
 const project = parseProject({schemaVersion:1,id:"p",title:"Test",aspect:"16:9",knowledgeSources:[],scenes:[{id:"one",kind:"title",title:"Scene",narration:{text:"Text"}}]});
 const scripts:ProjectDocuments={version:1,projectId:"p",activeId:"s",documents:[{id:"s",title:"Script",kind:"script",content:"Body",updatedAt:1}]};
 const designs:ProjectDesignDocuments={version:1,projectId:"p",activeId:"d",documents:[{id:"d",title:"Slides",kind:"slides",activePageId:"page",updatedAt:1,pages:[{id:"page",title:"Page",html:"<h1>Hello</h1>"}]}]};
 const before=JSON.stringify([project,scripts,designs]);
 const items=projectBoardItems(project,scripts,designs);
 expect(items.map(item=>item.target)).toEqual([{kind:"scene",id:"one"},{kind:"script",id:"s"},{kind:"design",id:"d",pageId:"page"}]);
 expect(new Set(items.map(item=>item.key)).size).toBe(3);
 expect(JSON.stringify([project,scripts,designs])).toBe(before);
});
it("keeps another window's saved layout instead of overwriting it on arrange or undo", async () => {
 const key = "glint:project-board:v1:board-concurrent";
 const original = JSON.stringify({"scene:one":{x:20,y:30}});
 localStorage.setItem(key, original);
 const node = document.createElement("div"); document.body.append(node);
 const root = createRoot(node);
 const project = parseProject({schemaVersion:1,id:"board-concurrent",title:"Test",aspect:"16:9",knowledgeSources:[],scenes:[{id:"one",kind:"title",title:"Scene",narration:{text:"Text"}}]});
 try {
  await act(async()=>root.render(createElement(ProjectBoard,{project,scripts:{version:1,projectId:project.id,activeId:"",documents:[]},designs:{version:1,projectId:project.id,activeId:"",documents:[]},onOpen:()=>{}})));
  const buttons = ()=>[...node.querySelectorAll("button")];
  await act(async()=>buttons().find(button=>button.textContent==="整理")!.click());
  expect(localStorage.getItem(key)).toBe("{}");
  const foreign = JSON.stringify({"scene:one":{x:90,y:100}});
  localStorage.setItem(key,foreign);
  await act(async()=>buttons().find(button=>button.textContent==="撤销布局")!.click());
  expect(localStorage.getItem(key)).toBe(foreign);
  expect(node.textContent).toContain("其他窗口更新");
  await act(async()=>buttons().find(button=>button.textContent==="整理")!.click());
  expect(localStorage.getItem(key)).toBe(foreign);
 } finally { await act(async()=>root.unmount()); node.remove(); localStorage.removeItem(key); }
});
