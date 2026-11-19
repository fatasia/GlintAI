import {copyProjectWorkspace} from "@glintai/scenescript";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { zipSync, unzipSync, strToU8 } from "fflate";
import { JSDOM } from "jsdom";
import { parseSnapshot, parseDocuments, parseWorkspace } from "./project-git-files.mjs";
import { validatePortableMedia } from "./portable-chapter-migration.ts";

export const PROJECT_ARCHIVE_LIMIT = 32 * 1024 * 1024;
const NAME = /^[a-zA-Z0-9_-]{1,100}\.(png|jpg|webp|mp4|mp3|wav)$/;
const hash = value => createHash("sha256").update(value).digest("hex");
const fail = message => { throw new Error(message); };
const text = bytes => new TextDecoder("utf-8", {fatal:true}).decode(bytes);
function snapshot(value) {
  if (!value || !["scene","nle"].includes(value.kind) || Object.keys(value).some(key=>!["kind","project","documents","workspace"].includes(key))) fail("工程包元数据格式无效。");
  const project = parseSnapshot(value.kind,value.project,value.project?.id);
  const documents = parseDocuments(value.documents);
  const result = {kind:value.kind,project,documents,...(value.workspace === undefined ? {} : {workspace:parseWorkspace(value.workspace,project.id)})};
  if (!isDeepStrictEqual(value,result)) fail("工程包含无法完整恢复的字段，请先检查数据格式。");
  if (Buffer.byteLength(JSON.stringify(result)) > 5 * 1024 * 1024) fail("工程文本超过 5 MiB。");
  return result;
}
/** Only explicitly referenced library files; never read paths supplied by an archive. */
function references(value) {
  const names = new Set();
  const add = ref => {
    if (!ref || ref.startsWith("#")) return;
    if (/^data:image\/(png|jpeg|webp|gif);base64,/i.test(ref)) return;
    const match = /^(?:\/api\/media\/assets\/|\/?assets\/)([^/]+)$/.exec(ref);
    if (!match || !NAME.test(match[1])) fail(`工程依赖未托管的素材：${ref.slice(0,120)}。请先导入素材库。`);
    names.add(match[1]);
    if (names.size > 100) fail("工程引用超过 100 个素材。");
  };
  const walk = (item,key="") => {
    if (typeof item === "string") {
      if (/^(?:src|.*Src|audioRef|outputAsset)$/.test(key)) add(item);
      return;
    }
    if (Array.isArray(item)) {for(const child of item) key === "refs" && typeof child === "string" ? add(child) : walk(child,key);}
    else if (item && typeof item === "object") for(const [name,child] of Object.entries(item)) walk(child,name);
  };
  walk(value.project);walk(value.workspace?.generation);walk(value.workspace?.timeline?.project);
  for(const asset of value.workspace?.assets ?? []) add(asset.url);
  for(const doc of value.workspace?.designs.documents ?? []) for(const page of doc.pages) {
    const dom = new JSDOM(page.html);
    try {
      for(const node of dom.window.document.querySelectorAll('[src],[poster],link[href],object[data],use[href]')) {
        for(const attr of ["src","poster","href","data"]) if(node.hasAttribute(attr)) add(node.getAttribute(attr));
      }
      if(dom.window.document.querySelector('[srcset]')) fail("工程含 srcset 资源，请先改为素材库单图再打包。");
      const css=[...dom.window.document.querySelectorAll('style,[style]')].map(node=>node.tagName === "STYLE" ? node.textContent : node.getAttribute('style')).join('\n');
      if(/@import/i.test(css)) fail("工程含外部 CSS，请先内联再打包。");
      for(const match of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi)) add((match[1]??match[2]??match[3]).trim());
    } finally {dom.window.close();}
  }
  return [...names].sort();
}
function approvals(value, assets) {
  for (const identity of value.project.assets ?? []) {
    const approval=identity.approval;
    if(!approval?.refSha256)continue;
    const name=approval.refs?.[0]?.split('/').at(-1), bytes=assets.get(name);
    if(!bytes || hash(bytes)!==approval.refSha256)fail("已批准角色或商品的参考素材与冻结摘要不一致。");
  }
}
export async function exportProjectArchive(input, store, signal) {
  const value=snapshot(input), entries={"project.json":strToU8(JSON.stringify(value))};
  let total=entries["project.json"].length;const assets=[];
  for(const name of references(value)) {
    signal?.throwIfAborted();const bytes=await store.read(name);total+=bytes.length;
    if(total>PROJECT_ARCHIVE_LIMIT) fail("工程与素材超过 32 MiB，请拆分工程。");
    await validatePortableMedia(bytes,name.split('.').at(-1),signal);
    entries[`assets/${name}`]=bytes;assets.push({name,bytes:bytes.length,sha256:hash(bytes)});
  }
  approvals(value,new Map(Object.entries(entries).filter(([name])=>name.startsWith("assets/")).map(([name,bytes])=>[name.slice(7),bytes])));
  entries["manifest.json"]=strToU8(JSON.stringify({format:"glint-project",version:1,projectSha256:hash(entries["project.json"]),assets}));
  const bytes=Buffer.from(zipSync(entries,{level:6}));
  if(bytes.length>PROJECT_ARCHIVE_LIMIT) fail("工程包超过 32 MiB。");
  return bytes;
}
export async function inspectProjectArchive(bytes, store, signal) {
  if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>PROJECT_ARCHIVE_LIMIT) fail("工程 ZIP 为空或超过 32 MiB。");
  let total=0;const seen=new Set();
  const files=unzipSync(bytes,{filter:entry=>{
    if(seen.has(entry.name)||seen.size>=102||!Number.isSafeInteger(entry.originalSize)||entry.originalSize<0) fail("ZIP 含重复或无效文件。");
    if(!["project.json","manifest.json"].includes(entry.name)&&!(entry.name.startsWith("assets/")&&NAME.test(entry.name.slice(7)))) fail("ZIP 含未知文件或非法路径。");
    seen.add(entry.name);total+=entry.originalSize;if(total>PROJECT_ARCHIVE_LIMIT) fail("ZIP 解压大小超过 32 MiB。");return true;
  }});
  if(!files["manifest.json"]||!files["project.json"])fail("工程包缺少清单或工程文件。");
  if(files["manifest.json"].length>256*1024||files["project.json"].length>5*1024*1024||Object.values(files).reduce((sum,bytes)=>sum+bytes.length,0)>PROJECT_ARCHIVE_LIMIT)fail("ZIP 展开内容超过上限。");
  const manifest=JSON.parse(text(files["manifest.json"]));
  if(manifest.format!=="glint-project"||manifest.version!==1||Object.keys(manifest).sort().join(',')!=="assets,format,projectSha256,version"||!Array.isArray(manifest.assets)||manifest.assets.length>100||hash(files["project.json"])!==manifest.projectSha256)fail("工程清单或摘要无效。");
  const value=snapshot(JSON.parse(text(files["project.json"]))), names=references(value), assets=new Map();
  for(const asset of manifest.assets){
    if(!asset||Object.keys(asset).sort().join(',')!=="bytes,name,sha256"||!NAME.test(asset.name)||assets.has(asset.name))fail("素材清单无效或重复。");
    const blob=files[`assets/${asset.name}`];
    if(!blob||blob.length!==asset.bytes||hash(blob)!==asset.sha256)fail("素材缺失或摘要不匹配。");
    const data=Buffer.from(blob);await validatePortableMedia(data,asset.name.split('.').at(-1),signal);
    try{const existing=await store.read(asset.name);if(!existing.equals(data))fail(`素材 ${asset.name} 已存在且内容不同，未覆盖。`);}catch(error){if(error.code!=="ENOENT")throw error;}
    assets.set(asset.name,data);
  }
  if(names.length!==assets.size||names.some(name=>!assets.has(name))||Object.keys(files).length!==assets.size+2)fail("工程引用与包内素材不完整或含多余文件。");
  if(new Set([...assets.keys()].map(name=>name.toLowerCase())).size!==assets.size)fail("素材名称大小写冲突。");
  approvals(value,assets);
  return {value,assets,sha256:hash(bytes)};
}
export async function importProjectArchive(bytes, store, signal) {
  const checked=await inspectProjectArchive(bytes,store,signal);
  const id=randomUUID();
  const copy={...checked.value,project:{...checked.value.project,id},...(checked.value.workspace?{workspace:copyProjectWorkspace(checked.value.workspace,id)}:{})};
  snapshot(copy);
  for(const [name,data] of checked.assets){signal?.throwIfAborted();await store.publish(name,data);}
  return copy;
}
