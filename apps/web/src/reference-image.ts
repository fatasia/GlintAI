export type ReferenceImage={name:string;mimeType:"image/png";data:string};
/** Downscale locally before the user submits a reference to the configured model. */
export async function readReferenceImage(file:File):Promise<ReferenceImage>{
  if(file.size>8*1024*1024)throw new Error("参考 PNG 超过 8 MiB，请先缩小图片。");
  const bytes=new Uint8Array(await file.arrayBuffer());
  if(bytes.length<33||[137,80,78,71,13,10,26,10].some((value,index)=>bytes[index]!==value))throw new Error("请上传 PNG 截图。");
  const view=new DataView(bytes.buffer),width=view.getUint32(16),height=view.getUint32(20);
  if(!width||!height||width>8192||height>8192||width*height>16777216)throw new Error("参考图尺寸超过限制，请先缩小截图。");
  const bitmap=await createImageBitmap(file);
  try{
    let scale=Math.min(1,1600/Math.max(bitmap.width,bitmap.height));
    const canvas=document.createElement("canvas"),context=canvas.getContext("2d");if(!context)throw new Error("无法准备参考图。");
    while(true){
      canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));context.drawImage(bitmap,0,0,canvas.width,canvas.height);
      const data=canvas.toDataURL("image/png").split(",")[1]!;
      if(data.length<=Math.floor(512*1024/3)*4)return{name:file.name.slice(0,150),mimeType:"image/png",data};
      if(Math.min(canvas.width,canvas.height)<=64)throw new Error("参考图压缩后仍超过 512 KiB。");
      scale*=.75;
    }
  }finally{bitmap.close();}
}
