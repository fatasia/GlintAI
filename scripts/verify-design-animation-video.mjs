import fs from 'node:fs';import path from'node:path';import{spawnSync}from'node:child_process';import assert from'node:assert/strict';import{renderNative}from'../apps/studio/scripts/native-render.ts';
const root=process.argv[2];if(!root||!path.isAbsolute(root))throw new Error('Pass the animation evidence directory');
for(const[key,dir]of Object.entries({GLINT_CACHE_DIR:'cache',GLINT_SESSION_DIR:'sessions',GLINT_DATA_DIR:'data'})){process.env[key]=path.join(root,dir);fs.mkdirSync(process.env[key],{recursive:true});}
const scene=JSON.parse(fs.readFileSync(path.join(root,'scene.json'),'utf8'));scene.narration={text:scene.narration.text,durationMs:4000};delete scene.transition;
const file=path.join(root,'project.json'),output=path.join(root,'animation.mp4');fs.writeFileSync(file,JSON.stringify({schemaVersion:1,id:'entrance-video',title:'入场动画验收',aspect:'16:9',fps:30,knowledgeSources:[],scenes:[scene]}));
await renderNative({projectPath:file,output,fast:true,tts:'mock',music:'off',noCache:true});
const probe=spawnSync('ffprobe',['-v','error','-show_streams','-show_format','-of','json',output],{encoding:'utf8',windowsHide:true});assert.equal(probe.status,0,probe.stderr);const metadata=JSON.parse(probe.stdout);assert.equal(metadata.streams[0].codec_name,'h264');
const samples=[];
for(const[time,name]of[[0.5,'before'],[1.5,'during'],[3,'after']]){
 const image=path.join(root,`${name}.png`);const frame=spawnSync('ffmpeg',['-y','-v','error','-ss',String(time),'-i',output,'-frames:v','1',image],{encoding:'utf8',windowsHide:true});assert.equal(frame.status,0,frame.stderr);
 const pixels=spawnSync('ffmpeg',['-v','error','-i',image,'-vf','crop=800:120:50:60','-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','-'],{windowsHide:true,maxBuffer:1024*1024});assert.equal(pixels.status,0);let dark=0;for(let i=0;i<pixels.stdout.length;i+=3)if(pixels.stdout[i]<180&&pixels.stdout[i+1]<180&&pixels.stdout[i+2]<180)dark++;samples.push({time,name,darkPixels:dark});
}
assert.ok(samples[2].darkPixels>samples[0].darkPixels+100,'Title must become visible in actual rendered video');
fs.writeFileSync(path.join(root,'video-report.json'),JSON.stringify({passed:true,output,silent:true,metadata,samples},null,2));console.log(JSON.stringify({passed:true,output,samples}));
