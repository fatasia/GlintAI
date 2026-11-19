/** Make a page-sized copy; the source image is never overwritten. */
export async function optimizeDesignImage(file:Blob,limit=512*1024):Promise<Blob>{
 if(!/^image\/(png|jpeg|webp)$/.test(file.type)||!file.size||file.size>8*1024*1024)throw new Error('页面优化支持 8 MiB 内的 PNG、JPEG、WebP；GIF 请先压缩，保留动画原文件。');
 const bitmap=await createImageBitmap(file);
 try{
  if(!bitmap.width||!bitmap.height||bitmap.width>8192||bitmap.height>8192||bitmap.width*bitmap.height>16777216)throw new Error('图片尺寸超过页面优化限制。');
  let scale=Math.min(1,1600/Math.max(bitmap.width,bitmap.height));
  const canvas=document.createElement('canvas'),context=canvas.getContext('2d');if(!context)throw new Error('浏览器无法优化图片。');
  for(let attempt=0;attempt<12;attempt++){
   canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));context.drawImage(bitmap,0,0,canvas.width,canvas.height);
   const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(new Error('图片编码失败。')),'image/webp',.92));
   if(blob.size<=limit)return blob;
   if(Math.min(canvas.width,canvas.height)<=64)break;scale*=.75;
  }
  throw new Error('图片优化后仍超过页面大小限制。');
 }finally{bitmap.close();}
}
