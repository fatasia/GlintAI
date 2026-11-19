import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';import{createRequire}from'node:module';const{unzipSync,strFromU8}=createRequire(new URL('../apps/web/package.json',import.meta.url))('fflate');import{createDesignExporter}from'../apps/web/server/design-export.mjs';
const out=process.argv[2];if(!out||!path.isAbsolute(out))throw new Error('Pass an absolute acceptance directory');const document=JSON.parse(await fs.readFile(path.join(out,'document.json'),'utf8'));
const exporter=createDesignExporter({outputDir:path.join(out,'exports')}),report=[];
for(const format of ['html','zip','png','pdf','pptx']){const result=await exporter.run({document,format}),bytes=await fs.readFile(result.path);
 if(format==='pdf')assert.equal(bytes.toString('latin1').match(/\/Type\s*\/Page\b/g)?.length,document.pages.length);
 if(format==='png'){assert.equal(bytes.readUInt32BE(16),1280);assert.equal(bytes.readUInt32BE(20),720);}
 if(format==='pptx'){const files=unzipSync(bytes);assert.equal(Object.keys(files).filter(name=>/^ppt\/slides\/slide\d+\.xml$/.test(name)).length,document.pages.length);for(let i=0;i<document.pages.length;i++){assert.ok(strFromU8(files[`ppt/slides/slide${i+1}.xml`]).includes('<a:t>'));assert.ok(strFromU8(files[`ppt/notesSlides/notesSlide${i+1}.xml`]).includes(document.pages[i].notes));}assert.ok(result.editableElements>=document.pages.length);}
 report.push({format,...result});await fs.writeFile(path.join(out,'exports-report.json'),JSON.stringify(report,null,2));
}console.log(JSON.stringify(report,null,2));
