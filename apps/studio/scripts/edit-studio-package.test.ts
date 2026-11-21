import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
import {expect,it} from 'vitest';
import {esmNodeShim} from '../../desktop/scripts/portable-service-build.mjs';

it('serves the packaged image editor without repository TypeScript files',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'glint-edit-package-'));
 let server:{url:string;close():Promise<void>}|undefined;
 try{
  const scripts=path.resolve('apps/studio/scripts'),entry=path.join(root,'edit.mjs');
  // The shipping ESM shim, not a reduced copy: bundled CJS code paths reach for
  // `__filename` and must run under plain Node, not vitest's module wrapper.
  await build({entryPoints:[path.join(scripts,'edit-studio.ts')],outfile:entry,bundle:true,platform:'node',format:'esm',target:'node22',logLevel:'silent',banner:{js:esmNodeShim}});
  await build({stdin:{contents:'import{editRuntime}from"./edit-studio/runtime";editRuntime();',resolveDir:scripts,loader:'ts'},outfile:path.join(root,'edit-studio/runtime.js'),bundle:true,platform:'browser',format:'iife',target:'chrome120',logLevel:'silent'});
  // Load with Node's own module machinery, not vitest's vite-node loader:
  // hosted runners expose temp paths with 8.3 short names (RUNNER~1), whose
  // tilde percent-encoding breaks vite module ids, and the bundle must prove
  // it runs under plain Node anyway.
  const module=createRequire(import.meta.url)(entry) as {startEditStudio(dir:string,port?:number):Promise<{url:string;close():Promise<void>}>};
  server=await module.startEditStudio(root,undefined);
  const response=await fetch(server!.url),html=await response.text();
  expect(response.status).toBe(200);expect(html).toContain('Glint 图片编辑台');expect(html).toContain('editRuntime();');
  expect(fs.existsSync(path.join(root,'edit-studio/runtime.ts'))).toBe(false);
  const state=await(await fetch(server!.url+'/api/state')).json();expect(state).toMatchObject({images:[],canEdit:false});
 }finally{await server?.close();fs.rmSync(root,{recursive:true,force:true});}
},30000);
