import { describe, expect, it } from "vitest";
import { parseProjectWorkspace, PROJECT_WORKSPACE_BYTES, type ProjectWorkspace } from "./project-workspace";

const projectId = "workspace-test";
function workspace(): ProjectWorkspace {
  return {
    version: 1, projectId,
    designs: { version: 1, projectId, activeId: "design", documents: [{
      id: "design", title: "设计", kind: "slides", activePageId: "page", updatedAt: 1,
      pages: [{ id: "page", title: "页面", html: "<main>原稿</main>", notes: "备注", annotations: [{ id: "mark", x: 0, y: 100, text: "批注", nodeId: "title-1", createdAt: 0 }] }],
    }] },
    brand: { name: "品牌", accent: "#abcdef", bg: "#000000", text: "#FFFFFF", logoText: "标识", displayFont: "'Noto Sans', sans-serif" },
    assets: [{ name: "cover.png", url: "/api/media/assets/cover.png", bytes: 512 * 1024 }],
  };
}
const parse = (value: unknown) => parseProjectWorkspace(value, projectId);

describe("parseProjectWorkspace 共享安全契约", () => {
  it("完整保留源码、批注、品牌和素材引用，返回独立 JSON 数据", () => {
    const value = workspace(), result = parse(value);
    expect(result).toEqual(value); expect(result).not.toBe(value);
    result.designs.documents[0]!.pages[0]!.html = "修改";
    expect(value.designs.documents[0]!.pages[0]!.html).toBe("<main>原稿</main>");
  });
  it("接受显式空 workspace，而不是把缺字段当作空附件", () => {
    const empty = { version: 1, projectId, designs: { version: 1, projectId, documents: [], activeId: "" }, brand: null, assets: [] };
    expect(parse(empty)).toEqual(empty);
    for (const field of ["version", "projectId", "designs", "brand", "assets"]) {
      const value = { ...empty } as Record<string, unknown>; delete value[field]; expect(() => parse(value)).toThrow();
    }
  });
  it.each(["workspace", "designs", "document", "page", "annotation", "brand", "asset"])("拒绝 %s 层未知字段，不能静默删除", level => {
    const value = workspace();
    const target = { workspace: value, designs: value.designs, document: value.designs.documents[0]!, page: value.designs.documents[0]!.pages[0]!, annotation: value.designs.documents[0]!.pages[0]!.annotations![0]!, brand: value.brand!, asset: value.assets[0]! }[level]!;
    Object.assign(target, { extra: "不能丢弃" }); expect(() => parse(value)).toThrow();
  });
  it.each(["workspace", "designs"])("拒绝 %s 的其他工程身份", level => {
    const value = workspace(); (level === "workspace" ? value : value.designs).projectId = "foreign";
    expect(() => parse(value)).toThrow(/不属于当前工程/);
  });
  it("接受 32 文档和总计 100 页，分别拒绝 33 文档和跨文档 101 页", () => {
    const value = workspace(), template = value.designs.documents[0]!;
    value.designs.documents = Array.from({ length: 32 }, (_, index) => ({ ...template, id: `design-${index}`, pages: Array.from({ length: index === 0 ? 69 : 1 }, (_, page) => ({ ...template.pages[0]!, id: `page-${page}` })), activePageId: "page-0" }));
    value.designs.activeId = "design-0";
    expect(parse(value).designs.documents).toHaveLength(32);
    value.designs.documents.push({ ...template, id: "extra" }); expect(() => parse(value)).toThrow();
    value.designs.documents.pop(); value.designs.documents[1]!.pages.push({ ...template.pages[0]!, id: "extra" });
    expect(() => parse(value)).toThrow(/100 页/);
  });
  it("按 UTF-8 字节接受单页恰好 1 MiB，拒绝多字节超界", () => {
    const value = workspace(), page = value.designs.documents[0]!.pages[0]!;
    page.html = "界".repeat(Math.floor(1024 * 1024 / 3)) + "a";
    expect(new TextEncoder().encode(page.html)).toHaveLength(1024 * 1024);
    expect(parse(value)).toEqual(value); page.html += "界"; expect(() => parse(value)).toThrow();
  });
  it("按序列化 UTF-8 字节接受恰好 2 MiB，拒绝再多一个字节", () => {
    const value = workspace(), doc = value.designs.documents[0]!;
    doc.pages[0]!.html = "x".repeat(1024 * 1024);
    const second = { id: "second", title: "第二页", html: "" }; doc.pages.push(second);
    second.html = "y".repeat(PROJECT_WORKSPACE_BYTES - new TextEncoder().encode(JSON.stringify(value)).length);
    expect(new TextEncoder().encode(JSON.stringify(value))).toHaveLength(PROJECT_WORKSPACE_BYTES);
    expect(parse(value)).toEqual(value); second.html += "z"; expect(() => parse(value)).toThrow(/2 MiB/);
  });
  it.each(["文档重复", "页面重复", "批注重复", "活动文档缺失", "活动页面缺失", "空活动文档"])("拒绝身份异常：%s", mode => {
    const value = workspace(), doc = value.designs.documents[0]!, page = doc.pages[0]!;
    if (mode === "文档重复") value.designs.documents.push(structuredClone(doc));
    if (mode === "页面重复") doc.pages.push(structuredClone(page));
    if (mode === "批注重复") page.annotations!.push({ ...page.annotations![0]! });
    if (mode === "活动文档缺失") value.designs.activeId = "missing";
    if (mode === "活动页面缺失") doc.activePageId = "missing";
    if (mode === "空活动文档") { value.designs.documents = []; value.designs.activeId = "missing"; }
    expect(() => parse(value)).toThrow();
  });
  it.each([
    { name: "<img>" }, { name: "品牌\u0000" }, { logoText: "\n标识" }, { logoText: "x".repeat(25) },
    { accent: "red" }, { bg: "#fff;display:none" }, { text: "#12345g" },
    { displayFont: "serif; background:url(evil)" }, { displayFont: "url(evil)" }, { displayFont: " " },
  ])("拒绝不安全品牌字段 %j", patch => {
    const value = workspace(); Object.assign(value.brand!, patch); expect(() => parse(value)).toThrow();
  });
  it("接受 40 个引用及两种允许路径，拒绝 41 个和重复名称", () => {
    const value = workspace(); value.assets = Array.from({ length: 40 }, (_, index) => ({ name: `${index}.png`, url: `${index % 2 ? "/assets" : "/api/media/assets"}/${index}.png`, bytes: 512 * 1024 }));
    expect(parse(value).assets).toHaveLength(40);
    value.assets.push({ name: "extra.png", url: "/assets/extra.png", bytes: 1 }); expect(() => parse(value)).toThrow();
    value.assets.pop(); value.assets[1] = { ...value.assets[0]! }; expect(() => parse(value)).toThrow();
  });
  it.each([
    { url: "https://external.invalid/cover.png" }, { url: "//external.invalid/cover.png" }, { url: "/assets/../cover.png" },
    { url: "/assets/%63over.png" }, { url: "/assets/cover.png?token=secret" }, { url: "/assets/other.png" },
    { name: "../cover.png" }, { bytes: 0 }, { bytes: 1.5 }, { bytes: 512 * 1024 + 1 }, { bytes: Number.NaN },
  ])("拒绝不安全素材引用 %j", patch => {
    const value = workspace(); Object.assign(value.assets[0]!, patch); expect(() => parse(value)).toThrow();
  });
  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])("拒绝非有限或负时间 %s", time => {
    const value = workspace(); value.designs.documents[0]!.updatedAt = time; expect(() => parse(value)).toThrow();
  });
  it("拒绝循环和 BigInt 等无法序列化的输入", () => {
    const cyclic = workspace(); Object.assign(cyclic, { self: cyclic }); expect(() => parse(cyclic)).toThrow(/JSON/);
    expect(() => parse({ ...workspace(), extra: BigInt(1) })).toThrow(/JSON/);
  });
  it("严格 JSON 不接受可选字段的 undefined，不能在持久化时静默消失", () => {
    const value = workspace(); value.designs.documents[0]!.pages[0]!.notes = undefined;
    expect(() => parse(value)).toThrow();
  });
});

it("round trips canvas positions and viewport in the bounded workspace contract",()=>{
 const value={...workspace(),board:{positions:{"design:d:p":{x:-20,y:40}},viewport:{x:120,y:-30,zoom:0.75}}};
 expect(parse(value)).toEqual(value);
 for(const board of [{positions:{a:{x:Infinity,y:0}}},{positions:{},viewport:{x:0,y:0,zoom:10}},{positions:{},secret:"unexpected"}])expect(()=>parse({...workspace(),board})).toThrow();
});

it("validates generation graphs and binds every portable receipt to its original node",()=>{
 const createdAt="2026-11-01T00:00:00.000Z";
 const generation={canvas:{schemaVersion:1,nodes:[{id:"image-1",kind:"image",prompt:"cover",model:"",state:"running",outputAsset:"",error:"",createdAt,updatedAt:createdAt}],edges:[]},positions:{"image-1":{x:20,y:30}},receipts:{"image-1":{requestId:"request-1",nodeCreatedAt:createdAt}}};
 expect(parse({...workspace(),generation}).generation).toEqual(generation);
 for(const changed of [
  {...generation,receipts:{"missing":generation.receipts["image-1"]}},
  {...generation,receipts:{"image-1":{...generation.receipts["image-1"],nodeCreatedAt:"2026-10-31T00:00:00.000Z"}}},
  {...generation,receipts:{"image-1":{...generation.receipts["image-1"],authorization:"private"}}},
  {...generation,positions:{"image-1":{x:Infinity,y:0}}},
  {...generation,canvas:{...generation.canvas,edges:[{from:"image-1",to:"image-1"}]}},
 ]) expect(()=>parse({...workspace(),generation:changed})).toThrow();
});
