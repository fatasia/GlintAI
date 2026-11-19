import { randomBytes } from "node:crypto";
import { exportProjectArchive, inspectProjectArchive, importProjectArchive, PROJECT_ARCHIVE_LIMIT } from "./project-archive.mjs";

const CHUNK = 512 * 1024;
const TTL = 10 * 60_000;
/** Native IPC only. The desktop supplies the pinned store; no caller-controlled paths. */
export function createProjectArchiveHost({ openStore, now = () => performance.now() }) {
  let store, session, busy=false, closed=false;
  const controller=new AbortController();
  const library=()=>store ??= openStore();
  const active=request=>{
    if(!session||session.token!==request.token||now()>=session.expiresAt)throw new Error("工程包会话已过期，请重新选择文件。");
    return session;
  };
  return {
    async request(request) {
      if(closed)throw new Error("工程包服务已关闭。");
      if(busy)throw new Error("工程包正在处理，请稍候。");
      if(session&&now()>=session.expiresAt)session=undefined;
      busy=true;
      const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(65_000)]);
      try {
        switch(request.operation){
          case "cancel": if(session&&session.token===request.token)session=undefined;return {ok:true};
          case "export": {
            if(session)throw new Error("请先完成或取消当前工程包。");
            const bytes=await exportProjectArchive(request.snapshot,await library(),signal);
            session={mode:"export",bytes,token:randomBytes(24).toString("hex"),expiresAt:now()+TTL};
            return {token:session.token,bytes:bytes.length,chunkBytes:CHUNK};
          }
          case "read": {
            const current=active(request);
            if(current.mode!=="export"||!Number.isSafeInteger(request.offset)||request.offset<0||request.offset>=current.bytes.length)throw new Error("工程包读取位置无效。");
            return {offset:request.offset,base64:current.bytes.subarray(request.offset,request.offset+CHUNK).toString("base64")};
          }
          case "begin": {
            if(session)throw new Error("请先完成或取消当前工程包。");
            if(!Number.isSafeInteger(request.bytes)||request.bytes<1||request.bytes>PROJECT_ARCHIVE_LIMIT)throw new Error("请选择不超过 32 MiB 的工程 ZIP。");
            session={mode:"import",chunks:[],length:0,total:request.bytes,token:randomBytes(24).toString("hex"),expiresAt:now()+TTL};
            return {token:session.token,chunkBytes:CHUNK};
          }
          case "append": {
            const current=active(request);
            if(current.mode!=="import"||current.checked||current.length!==request.offset||typeof request.base64!=="string"||request.base64.length>Math.ceil(CHUNK/3)*4||!request.base64.length)throw new Error("工程包传输顺序或分块无效。");
            const bytes=Buffer.from(request.base64,"base64");
            if(bytes.toString("base64")!==request.base64||bytes.length>CHUNK||current.length+bytes.length>current.total)throw new Error("工程包分块大小或编码无效。");
            current.chunks.push(bytes);current.length+=bytes.length;return {offset:current.length};
          }
          case "preview": {
            const current=active(request);
            if(current.mode!=="import"||current.length!==current.total)throw new Error("工程包尚未传输完整。");
            current.bytes ??= Buffer.concat(current.chunks);current.chunks=[];
            const checked=await inspectProjectArchive(current.bytes,await library(),signal);
            current.checked=checked.sha256;
            return {sha256:checked.sha256,kind:checked.value.kind,title:checked.value.project.title,assets:checked.assets.size,bytes:current.total};
          }
          case "import": {
            const current=active(request);
            if(current.mode!=="import"||!current.checked||request.sha256!==current.checked)throw new Error("请先核对工程包预览再确认导入。");
            // Repeated confirmation returns the same project identity, never a second copy.
            current.result ??= await importProjectArchive(current.bytes,await library(),signal);
            return current.result;
          }
          default:throw new Error("未知的工程包操作。");
        }
      } finally {busy=false;}
    },
    async dispose(){closed=true;controller.abort();session=undefined;if(store)await(await store).close();},
  };
}
