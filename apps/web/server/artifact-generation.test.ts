import { expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { proposeArtifact } from "./artifact-proposal.mjs";
const document = () => ({id:"d",kind:"page",title:"Page",updatedAt:0,activePageId:"p",pages:[{id:"p",title:"Page",html:"<!doctype html><html><head></head><body></body></html>"}]});
const provider = (doc: ReturnType<typeof document>) => ({chat:async()=>({text:JSON.stringify({document:doc,summary:"生成页面"})})});
it("adds deterministic metadata to generated containers without changing supplied IDs or content", async () => {
  const before=document(), next=document();next.pages[0]!.html='<div><h1 data-design-id="generated-node-1">书店</h1><form><label>姓名<input></label></form></div>';
  const result=await proposeArtifact({document:before,instruction:"生成预约页面"},provider(next));
  const dom=new JSDOM(result.document.pages[0].html).window.document;
  const nodes=[...dom.body.querySelectorAll('*')];
  expect(nodes.every(node=>node.hasAttribute('data-design-id'))).toBe(true);
  expect(new Set(nodes.map(node=>node.getAttribute('data-design-id'))).size).toBe(nodes.length);
  expect(dom.querySelector('h1')!.getAttribute('data-design-id')).toBe('generated-node-1');
  expect(dom.body.textContent).toBe('书店姓名');
  expect(next.pages[0]!.html).not.toContain('generated-node-2');
});
it("does not turn duplicate IDs or new executable content into valid proposals",async()=>{
  for(const html of ['<div data-design-id="same"><h1 data-design-id="same">x</h1></div>','<div onclick="alert(1)">x</div>','<script>alert(1)</script>']){
    const next=document();next.pages[0]!.html=html;
    await expect(proposeArtifact({document:document(),instruction:"生成页面"},provider(next))).rejects.toThrow();
  }
});
it("retains strict selected-node scope instead of assigning IDs to unknown new nodes",async()=>{
  const before=document();before.pages[0]!.html='<h1 data-design-id="title">原文</h1>';
  const next=document();next.pages[0]!.html='<h1 data-design-id="title">新文</h1><div>多余内容</div>';
  await expect(proposeArtifact({document:before,instruction:"改标题",selection:{documentId:"d",pageId:"p",nodeId:"title",text:"原文"}},provider(next))).rejects.toThrow();
});
it("rejects malformed and external reference data before a model call",async()=>{
 let calls=0;
 for(const referenceImage of [{mimeType:"image/svg+xml",data:"PHN2Zz4="},{mimeType:"image/png",data:"https://example.com/image.png"},{mimeType:"image/png",data:"YWJj"}])
  await expect(proposeArtifact({document:document(),instruction:"参考截图",referenceImage},{chat:async()=>{calls++;return{text:"{}"};}})).rejects.toThrow(/参考图/);
 expect(calls).toBe(0);
});
it("accepts only an empty misplaced provider annotation list, never nonempty annotations or unknown data",async()=>{
 const before=document();
 const misplaced={...before,annotations:[]} as ReturnType<typeof document>;
 const result=await proposeArtifact({document:before,instruction:"生成页面"},provider(misplaced));
 expect(result.document).not.toHaveProperty("annotations");
 for(const fields of [{annotations:[{text:"真实批注"}]},{unexpected:"keep this"}])
  await expect(proposeArtifact({document:before,instruction:"生成页面"},provider({...before,...fields}))).rejects.toThrow();
});
it("does not expose upstream response bodies or configuration in provider failures",async()=>{
 await expect(proposeArtifact({document:document(),instruction:"生成页面"},{chat:async()=>{throw new Error("credential-from-provider-body");}})).rejects.toThrow("模型生成未完成");
});
