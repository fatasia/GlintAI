// @vitest-environment jsdom
import{expect,it}from'vitest';import{patchDesignNodes,describeDesignNode}from'./design-editor-dom';import{designEntranceTimeline,styleAt,type DesignEntrance}from'./design-animation';import{appendDesignSlides}from'./design-to-video';import{parseProject}from'@glintai/scenescript';import{buildDesignPreview}from'./design-editor-bridge';
const html='<!doctype html><html><head></head><body><h1 data-design-id="title">逐步显示的标题</h1><p data-design-id="body">晚一点显示的正文。</p></body></html>';
it('stores editable entrance timing without changing text, geometry or stable identity',()=>{
 const next=patchDesignNodes(html,['title'],{entrance:{type:'rise',durationMs:1000,delayMs:500}});
 expect(describeDesignNode(next,'title')?.entrance).toEqual({type:'rise',durationMs:1000,delayMs:500});expect(next).toContain('glint-design-rise');expect(next).toContain('逐步显示的标题');
 expect(buildDesignPreview(next,'g',false,{})).toContain('animation:none!important');
 expect(buildDesignPreview(next,'g',true,{})).not.toContain('[data-design-enter]{animation:none!important}');
 const removed=patchDesignNodes(next,['title'],{entrance:{type:'none',durationMs:600,delayMs:0}});expect(removed).not.toContain('data-design-enter');expect(removed).not.toContain('data-glint-design-motion');
});
it('rejects invalid timing and preserves locked elements',()=>{
 expect(()=>patchDesignNodes(html,['title'],{entrance:{type:'fade',durationMs:99,delayMs:0}})).toThrow('参数');
 expect(()=>patchDesignNodes(html,['title'],{entrance:{type:'zoom',durationMs:500,delayMs:10001}})).toThrow('参数');
 const locked=patchDesignNodes(html,['title'],{locked:true});expect(patchDesignNodes(locked,['title'],{entrance:{type:'fade',durationMs:500,delayMs:0}})).toBe(locked);
});
it('converts managed entrance metadata to an animation-field-free video scene that rasterizes statically',()=>{
 const source=patchDesignNodes(html,['title'],{entrance:{type:'rise',durationMs:600,delayMs:500}}),doc={id:'deck',title:'演示',kind:'slides' as const,activePageId:'one',updatedAt:0,pages:[{id:'one',title:'一',html:source,notes:'本页旁白。'}]};
 const project=parseProject({schemaVersion:1,id:'film',title:'片',aspect:'16:9',knowledgeSources:[],scenes:[{id:'first',kind:'title',title:'开场',narration:{text:'开场。'}}]});
 const scene=appendDesignSlides(project,doc,{id:'animated'}).scenes[1]!;expect(scene).toMatchObject({kind:'html',presentation:'slide',narration:{text:'本页旁白。'}});
 if(scene.kind!=='html')throw Error();expect(scene.animation).toBeUndefined();
 expect(scene.html).not.toContain('<script');expect(scene.html).not.toContain('@keyframes');expect(scene.html).toContain('data-design-enter');
 expect(()=>appendDesignSlides(project,{...doc,pages:[{...doc.pages[0]!,html:source+'<img src="/api/media/assets/pic.png">'}]},{id:'blocked'})).toThrow('外部素材');
});

it('solves entrance frames with quad ease-out and seekable runtime at the shipped sample times',async()=>{
 const entrance:DesignEntrance={type:'rise',durationMs:1000,delayMs:1000};
 expect(styleAt(entrance,0)).toEqual({opacity:0,transform:'translateY(32px)'});
 expect(styleAt(entrance,1500)).toEqual({opacity:0.75,transform:'translateY(8.000px)'});
 expect(styleAt(entrance,3000)).toEqual({opacity:null,transform:null});
 expect(styleAt({type:'zoom',durationMs:1000,delayMs:0},500)).toEqual({opacity:0.75,transform:'scale(0.9750)'});
 expect(styleAt({type:'fade',durationMs:1000,delayMs:0},500)).toEqual({opacity:0.75,transform:null});
 expect(()=>styleAt(entrance,NaN)).toThrow('动画时间');
 expect(()=>styleAt(entrance,-1)).toThrow('动画时间');
 // The inlined runtime must reproduce styleAt exactly: run it in a real DOM and
 // seek out of order (0 → 1.5s → 3s → 0 → 3s), mirroring the video capture protocol.
 const page=patchDesignNodes(html,['title'],{entrance});
 const parsed=new DOMParser().parseFromString(page,'text/html');
 const code=designEntranceTimeline(parsed)!;
 // @ts-expect-error jsdom ships no types in this workspace; used only inside tests.
 const { JSDOM } = await import("jsdom");
 const dom=new JSDOM(page,{runScripts:'outside-only'});
 try {
   type Seekable={pause():Seekable;seek(seconds:number):Seekable};
   const timeline=dom.window.eval(`${code};window.__glintTimeline()`) as Seekable;
   const node=dom.window.document.querySelector('[data-design-id="title"]') as HTMLElement;
 const sample=(seconds:number)=>{timeline.pause().seek(seconds);return{opacity:node.style.opacity,transform:node.style.transform,computedOpacity:dom.window.getComputedStyle(node).opacity};};
 const values=[sample(0),sample(1.5),sample(3),sample(0),sample(3)];
 expect(values[0]).toMatchObject({opacity:'0',transform:'translateY(32px)'});
 expect(Number(values[1]!.computedOpacity)).toBeGreaterThan(0);expect(Number(values[1]!.computedOpacity)).toBeLessThan(1);
 expect(values[2]).toMatchObject({opacity:'',transform:''});
 expect(values[3]).toEqual(values[0]);expect(values[4]).toEqual(values[2]);
 } finally { dom.window.close(); }
});

it('keeps malformed imported animation metadata inspectable instead of crashing the editor',()=>{
 const broken=html.replace('data-design-id="title"','data-design-id="title" data-design-enter="unknown"');
 expect(describeDesignNode(broken,'title')?.entranceError).toContain('参数');
 const fixed=patchDesignNodes(broken,['title'],{entrance:{type:'none',durationMs:600,delayMs:0}});
 expect(describeDesignNode(fixed,'title')?.entrance?.type).toBe('none');
});

it('does not silently remove source-edited reserved motion styles',()=>{
 const source=patchDesignNodes(html,['title'],{entrance:{type:'fade',durationMs:750,delayMs:125}});
 const modified=source.replace('@keyframes glint-design-fade','body{color:red}@keyframes glint-design-fade');
 expect(()=>patchDesignNodes(modified,['title'],{entrance:{type:'none',durationMs:600,delayMs:0}})).toThrow('源码修改');
 const parsed=new DOMParser().parseFromString(modified,'text/html');
 expect(()=>designEntranceTimeline(parsed)).toThrow('源码修改');
 expect(parsed.querySelector('style')?.textContent).toContain('body{color:red}');
 expect(describeDesignNode(source,'title')?.entrance).toEqual({type:'fade',durationMs:750,delayMs:125});
});

it('edits only button and anchor page targets and leaves other node content unchanged',()=>{
 const source='<button data-design-id="go">查看详情</button><a data-design-id="back">返回</a><p data-design-id="text">文字</p>';
 const patched=patchDesignNodes(source,['go','back'],{pageTarget:'detail'});
 expect(describeDesignNode(patched,'go')?.pageTarget).toBe('detail');
 expect(patched).toContain('href="#detail"');
 expect(()=>patchDesignNodes(source,['text'],{pageTarget:'detail'})).toThrow('链接或按钮');
 expect(patchDesignNodes(patched,['go','back'],{pageTarget:''})).not.toContain('data-design-page');
});
