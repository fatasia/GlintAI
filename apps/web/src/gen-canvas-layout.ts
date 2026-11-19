export type GenerationLayout = Record<string, {x:number;y:number}>;
/** Reject damaged records rather than treating them as an empty, writable layout. */
export function readGenerationLayout(raw:string|null):GenerationLayout {
  if(raw===null)return {};
  if(raw.length>50000)throw new Error("生成画布布局过大");
  const value:unknown=JSON.parse(raw);
  if(!value || typeof value!=="object" || Array.isArray(value) || Object.keys(value).length>200)throw new Error("生成画布布局无效");
  const out:GenerationLayout=Object.create(null);
  for(const [id,point] of Object.entries(value)) {
    if(!/^[a-z0-9][a-z0-9-]{0,40}$/.test(id) || ["__proto__","constructor","prototype"].includes(id) || !point || typeof point!=="object" || Array.isArray(point) || Object.keys(point).some(key=>key!=="x"&&key!=="y"))throw new Error("生成画布位置无效");
    const {x,y}=point as {x:number;y:number};
    if(!Number.isFinite(x)||!Number.isFinite(y)||Math.abs(x)>100000||Math.abs(y)>100000)throw new Error("生成画布坐标无效");
    out[id]={x,y};
  }
  return out;
}
