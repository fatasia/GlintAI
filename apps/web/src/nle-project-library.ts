import { parseNleProject, type NleProject, type SceneNleLink } from "@glintai/scenescript";
import type { SessionState } from "@glintai/session";
import { createNleSession } from "./nle-session";
import type { NleStoredPair } from "./nle-storage";
export type NleBridge = { sourceId: string; projectId: string; links: SceneNleLink[] };
export type NleRecord = { version: 1; pair: NleStoredPair; bridge: NleBridge | null };
const PREFIX = "glint.nle.record.v1:";
export function nleRecordKey(id: string): string {
  if (!id || id.length > 200) throw new Error("剪辑工程编号无效。");
  return PREFIX + encodeURIComponent(id).replace(/[!'()*]/g, value=>`%${value.charCodeAt(0).toString(16).toUpperCase()}`);
}
export function parseNleBridge(value: unknown, projectId: string): NleBridge | null {
  if (value === null) return null;
  const bridge = value as NleBridge;
  if (!bridge || Object.keys(bridge).sort().join(",") !== "links,projectId,sourceId" || bridge.projectId !== projectId || typeof bridge.sourceId !== "string" || !bridge.sourceId || bridge.sourceId.length > 200 || !Array.isArray(bridge.links) || bridge.links.length > 100 || bridge.links.some(link =>
    !link || Object.keys(link).sort().join(",") !== "clipId,durationMs,sceneId,startMs,trackId" || [link.sceneId,link.trackId,link.clipId].some(id=>typeof id!=="string"||!id||id.length>200) || !Number.isFinite(link.startMs) || link.startMs<0 || !Number.isFinite(link.durationMs) || link.durationMs<=0))
    throw new Error("剪辑与源工程的关联记录无效，未自动回写。");
  return bridge;
}
export function parseNleRecord(raw: string, id: string): NleRecord {
  if(new TextEncoder().encode(raw).length>8*1024*1024)throw new Error("剪辑工程库记录超过 8 MiB。");
  const value=JSON.parse(raw) as NleRecord;
  if(!value||value.version!==1||Object.keys(value).sort().join(',')!=="bridge,pair,version"||!value.pair||Object.keys(value.pair).sort().join(',')!=="project,session"||typeof value.pair.project!=="string"||typeof value.pair.session!=="string")throw new Error("剪辑工程库记录损坏，原记录保留。");
  const project=parseNleProject(JSON.parse(value.pair.project)),session=JSON.parse(value.pair.session) as SessionState<NleProject>;
  if(project.id!==id||session.projectId!==id||JSON.stringify(parseNleProject(session.document))!==JSON.stringify(project))throw new Error("剪辑工程库身份或历史不匹配。");
  createNleSession(project,session);
  parseNleBridge(value.bridge,id);
  return value;
}
export function serializeNleRecord(pair:NleStoredPair,bridge:NleBridge|null):string {
  const raw=JSON.stringify({version:1,pair,bridge});
  parseNleRecord(raw,JSON.parse(pair.project!).id);return raw;
}
export function readNleLibrary(storage:Pick<Storage,"length"|"key"|"getItem">):Array<{id:string;title:string;raw:string}> {
  const records=[];
  for(let i=0;i<storage.length;i++){
    const key=storage.key(i);if(!key?.startsWith(PREFIX))continue;
    const id=decodeURIComponent(key.slice(PREFIX.length)),raw=storage.getItem(key);if(raw===null)continue;
    const record=parseNleRecord(raw,id),project=parseNleProject(JSON.parse(record.pair.project!));
    records.push({id,title:project.title,raw});
    if(records.length>100)throw new Error("剪辑工程库超过 100 项，请先导出整理。");
  }
  return records.sort((a,b)=>a.title.localeCompare(b.title));
}
