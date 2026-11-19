import { ARTIFACT_BODY_LIMIT, ARTIFACT_CONTENT_RULES, identifyGeneratedPage, parseArtifactSnapshot, validateArtifactSnapshot } from "./local-agent-artifacts.mjs";
import { boundedJson, demand, LocalAgentError } from "./local-agent-common.mjs";

export { ARTIFACT_BODY_LIMIT };
/** One configured-provider call; never mutates the supplied document or writes project data. */
export async function proposeArtifact(input, provider, { signal } = {}) {
  const request = boundedJson(input, ARTIFACT_BODY_LIMIT);
  demand(request && typeof request.instruction === "string" && request.instruction.trim() && request.instruction.length <= 32000, "invalid-instruction", "请输入 1 到 32000 字的生成或修改要求。");
  const document = request.document;
  const kind = ["page", "prototype", "slides"].includes(document?.kind) ? "design" : "script";
  const base = parseArtifactSnapshot(kind, { schemaVersion: 1, id: "artifact-api", title: "当前文档", document }, "artifact-api");
  // Validate stale/unknown/locked selections before spending a provider call.
  validateArtifactSnapshot(kind, base, base, request.selection);
  demand(provider && typeof provider.chat === "function", "provider-unavailable", "请先配置文本模型，再生成文档提案。");
  let images;
  if(request.referenceImage!==undefined){
    const image=request.referenceImage;
    demand(kind==="design"&&image&&Object.keys(image).sort().join(",")==="data,mimeType"&&image.mimeType==="image/png"&&typeof image.data==="string"&&image.data.length<=700000,"invalid-reference","参考图仅支持不超过 512 KiB 的 PNG。");
    const bytes=Buffer.from(image.data,"base64");
    demand(bytes.length>=33&&bytes.length<=512*1024&&bytes.toString("base64")===image.data&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&bytes.readUInt32BE(16)>0&&bytes.readUInt32BE(20)>0&&bytes.readUInt32BE(16)<=2048&&bytes.readUInt32BE(20)<=2048,"invalid-reference","参考图 PNG 字节或尺寸无效。");
    const {validatePortableMedia}=await import("./portable-chapter-migration.ts");
    try{await validatePortableMedia(bytes,"png",signal);}catch{demand(false,"invalid-reference","参考图无法解码，未发送给模型。");}
    images=[image];
  }
  signal?.throwIfAborted();
  const response = await provider.chat({
    system: `${ARTIFACT_CONTENT_RULES}\nAPI 返回 JSON：{\"document\":完整 document 对象,\"summary\":\"简短的人类可读修改说明\"}。不要返回 Markdown 代码围栏。`,
    messages: [{ role: "user", content: JSON.stringify({ document: base.document, instruction: request.instruction, ...(request.selection ? { selection: request.selection } : {}) }), ...(images?{images}:{}) }],
    json: true, temperature: 0.6, timeoutMs: 60000, signal,
  }).catch(() => {
    signal?.throwIfAborted();
    throw new LocalAgentError("provider-failed", "模型生成未完成；请检查服务、图像支持或推理强度后重试。");
  });
  signal?.throwIfAborted();
  demand(typeof response?.text === "string" && Buffer.byteLength(response.text) <= ARTIFACT_BODY_LIMIT, "invalid-response", "模型返回过大或为空，原文档未修改。");
  let value;
  try { value = JSON.parse(response.text); } catch { demand(false, "invalid-response", "模型未返回有效 JSON，原文档未修改；请重试。"); }
  demand(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(key => ["document", "summary"].includes(key)) && typeof value.summary === "string" && value.summary.trim() && value.summary.length <= 4000, "invalid-response", "模型提案或说明格式无效，原文档未修改。");
  // Some providers emit an empty top-level annotation list even though annotations
  // belong to pages. It carries no user content. Nonempty/unknown fields still fail.
  if(kind==="design"&&Array.isArray(value.document?.annotations)&&value.document.annotations.length===0){
    const {annotations,...document}=value.document;value.document=document;
  }
  const parsed = parseArtifactSnapshot(kind, { ...base, document: value.document }, base.id);
  const proposal = validateArtifactSnapshot(kind, base, identifyGeneratedPage(base, parsed, request.selection), request.selection);
  return { document: proposal.document, summary: value.summary };
}
