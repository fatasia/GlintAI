import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {expect,it} from 'vitest';

it('serves the packaged image editor without repository TypeScript files',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'glint-edit-package-'));
 let server:{url:string;close():Promise<void>}|undefined;
 try{
  const scripts=path.resolve('apps/studio/scripts'),entry=path.join(root,'edit.mjs');
  await build({entryPoints:[path.join(scripts,'edit-studio.ts')],outfile:entry,bundle:true,platform:'node',format:'esm',target:'node22',logLevel:'silent',banner:{js:'import {createRequire} from "node:module"; const require=createRequire(import.meta.url);'}});
  await build({stdin:{contents:'import{editRuntime}from"./edit-studio/runtime";editRuntime();',resolveDir:scripts,loader:'ts'},outfile:path.join(root,'edit-studio/runtime.js'),bundle:true,platform:'browser',format:'iife',target:'chrome120',logLevel:'silent'});
  const module=await import(/* @vite-ignore */pathToFileURL(entry).href);
  server=await module.startEditStudio(root,undefined);
  const response=await fetch(server!.url),html=await response.text();
  expect(response.status).toBe(200);expect(html).toContain('Glint 图片编辑台');expect(html).toContain('editRuntime();');
  expect(fs.existsSync(path.join(root,'edit-studio/runtime.ts'))).toBe(false);
  const state=await(await fetch(server!.url+'/api/state')).json();expect(state).toMatchObject({images:[],canEdit:false});
 }finally{await server?.close();fs.rmSync(root,{recursive:true,force:true});}
},30000);
