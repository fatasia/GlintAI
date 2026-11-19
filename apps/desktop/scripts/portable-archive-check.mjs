import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
const out=path.resolve(process.env.GLINT_PORTABLE_OUTPUT??'dist-portable/Glint'),app=path.join(out,'app');
if(!fs.existsSync(path.join(app,'server','service.mjs')))throw new Error('Build a portable package first');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'glint-package-archive-'));fs.mkdirSync(path.join(root,'media'));
const picture=path.join(root,'media','cover.png');execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=red:s=16x16','-frames:v','1',picture],{windowsHide:true});
const nonce=randomBytes(24).toString('hex'),pending=new Map();let sequence=0,buffer='';
const child=spawn(path.join(out,'node.exe'),[path.join(app,'server','service.mjs'),`--data-dir=${root}`,`--nonce=${nonce}`],{cwd:app,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,GLINT_WEB_DIST:path.join(app,'web'),GLINT_STUDIO_DIR:path.join(app,'studio'),GLINT_MAKE_ENTRY:path.join(app,'cli','glint.mjs')}});
let readyResolve,readyReject;const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
child.stdout.on('data',chunk=>{buffer+=String(chunk);let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);try{const value=JSON.parse(line);if(value.type==='ready')readyResolve(value);else if(value.type==='agent-result'){const item=pending.get(value.id);if(item){pending.delete(value.id);clearTimeout(item.timer);value.error||value.result?.ok===false?item.reject(new Error(value.error??value.result.error)):item.resolve(value.result);}}}catch{readyReject(new Error('Invalid native protocol'));}}});
child.on('error',readyReject);child.on('exit',code=>{readyReject(new Error(`Service exited ${code}`));for(const item of pending.values()){clearTimeout(item.timer);item.reject(new Error('Service exited'));}pending.clear();});
const request=(operation,extra={})=>new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`Archive ${operation} timeout`));},70000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({type:'agent',nonce,id,request:{action:'archive',operation,...extra}})+'\n');});
let readyTimer;
try{
 await Promise.race([ready,new Promise((_,reject)=>{readyTimer=setTimeout(()=>reject(new Error('Service startup timeout')),30000);})]);clearTimeout(readyTimer);
 const project={schemaVersion:1,id:'package-archive',title:'Portable archive',aspect:'16:9',knowledgeSources:[],scenes:[{id:'one',kind:'title',title:'First',narration:{text:'One',durationMs:1000}}]};
 const workspace={version:1,projectId:project.id,designs:{version:1,projectId:project.id,documents:[],activeId:''},brand:null,assets:[{name:'cover.png',url:'/api/media/assets/cover.png',bytes:fs.statSync(picture).size}]};
 const exported=await request('export',{snapshot:{kind:'scene',project,documents:[],workspace}});const chunks=[];
 for(let offset=0;offset<exported.bytes;){const value=await request('read',{token:exported.token,offset});const bytes=Buffer.from(value.base64,'base64');if(!bytes.length||value.offset!==offset)throw new Error('Invalid archive chunk');chunks.push(bytes);offset+=bytes.length;}
 const archive=Buffer.concat(chunks);await request('cancel',{token:exported.token});
 const upload=await request('begin',{bytes:archive.length});for(let offset=0;offset<archive.length;offset+=512*1024)await request('append',{token:upload.token,offset,base64:archive.subarray(offset,offset+512*1024).toString('base64')});
 const preview=await request('preview',{token:upload.token});const restored=await request('import',{token:upload.token,sha256:preview.sha256});
 if(restored.project.id===project.id||restored.workspace.projectId!==restored.project.id||preview.assets!==1)throw new Error('Invalid archive restore');
 console.log(JSON.stringify({package:out,nativeArchive:'passed',assets:preview.assets,zipBytes:archive.length,sha256:createHash('sha256').update(archive).digest('hex'),independentProject:true},null,2));
}finally{
 clearTimeout(readyTimer);
 if(child.exitCode===null&&!child.killed){child.stdin.end(JSON.stringify({type:'shutdown',nonce})+'\n');await Promise.race([new Promise(resolve=>child.once('exit',resolve)),new Promise(resolve=>setTimeout(resolve,3000))]);if(child.exitCode===null)child.kill();}
 const real=fs.realpathSync(root),temp=fs.realpathSync(os.tmpdir());if(path.dirname(real)!==temp||!path.basename(real).startsWith('glint-package-archive-'))throw new Error('Unsafe cleanup');fs.rmSync(real,{recursive:true,force:true});
}
