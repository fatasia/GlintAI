// Own checker texture encoded with the official Binomial Basis Universal WASM encoder.
// Usage: node examples/local-media/generate-ktx2.mjs <outside-repo basis_encoder.js>
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require=createRequire(import.meta.url), encoder=path.resolve(process.argv[2] ?? '');
if(!encoder.endsWith('basis_encoder.js')) throw new Error('Pass the official local basis_encoder.js path');
const module=await require(encoder)({wasmBinary:fs.readFileSync(encoder.replace(/\.js$/,'.wasm'))});
module.initializeBasis();
const e=new module.BasisEncoder(), w=64,h=64,pixels=new Uint8Array(w*h*4);
for(let y=0;y<h;y++) for(let x=0;x<w;x++) {
 const c=((x>>3)+(y>>3))%2?[244,157,46]:[36,150,188];
 pixels.set([...c,255],(y*w+x)*4);
}
try {
 e.setCreateKTX2File(true); e.setUASTC(false); e.setQualityLevel(200); e.setMipGen(true); e.setPerceptual(true); e.setKTX2AndBasisSRGBTransferFunc(true);
 if(!e.setSliceSourceImage(0,pixels,w,h,0)) throw new Error('RGBA input rejected');
 const output=new Uint8Array(1024*1024), length=e.encode(output);
 if(length<=0)throw new Error('Basis encoder failed');
 const dir=fileURLToPath(new URL('./assets/models/',import.meta.url));
 fs.writeFileSync(path.join(dir,'checker.ktx2'),output.subarray(0,length));
 const doc=JSON.parse(fs.readFileSync(path.join(dir,'cube.gltf'),'utf8'));
 doc.asset.generator='Glint own checker; official Basis Universal ETC1S encoder';
 doc.images=[{uri:'checker.ktx2',mimeType:'image/ktx2'}];
 doc.textures=[{sampler:0,extensions:{KHR_texture_basisu:{source:0}}}];
 doc.extensionsUsed=doc.extensionsRequired=['KHR_texture_basisu'];
 fs.writeFileSync(path.join(dir,'cube-ktx2.gltf'),JSON.stringify(doc,null,2)+'\n');
 console.log(`ETC1S KTX2 fixture: ${length} bytes`);
} finally { e.delete(); }
