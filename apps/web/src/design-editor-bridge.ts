import { htmlPolicy } from "../../../packages/video/src/scenes/html-policy";
import { parseDesignHtml, serializeDesignHtml } from "./design-editor-dom";
export const DESIGN_BRIDGE = "glint:design";
export type DesignBridgeMessage = { type: typeof DESIGN_BRIDGE; generation: string; action: "ready" | "select" | "edit" | "clear" | "gesture" | "comment" | "annotation" | "error" | "navigate"; pageId?: string; nodeId?: string; nodeIds?: string[]; annotationId?: string; text?: string; dx?: number; dy?: number; width?: number; height?: number; rotation?: number; x?: number; y?: number };
const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const json = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");
/** No origin check for opaque sandbox: exact WindowProxy + generation + closed message schema. */
export function readDesignBridgeMessage(event: MessageEvent, source: Window | null, generation: string): DesignBridgeMessage | undefined {
  if (!source || event.source !== source) return;
  const data = event.data;
  if (!data || typeof data !== "object" || data.type !== DESIGN_BRIDGE || data.generation !== generation || !["ready", "select", "edit", "clear", "gesture", "comment", "annotation", "error", "navigate"].includes(data.action)) return;
  const message: DesignBridgeMessage = { type: DESIGN_BRIDGE, generation, action: data.action };
  if(data.action === "navigate") {
    if(typeof data.pageId!=="string"||!data.pageId.trim()||data.pageId.length>200)return;
    message.pageId=data.pageId;
  }
  if (data.action === "select" || data.action === "gesture" || data.action === "edit") {
    if (typeof data.nodeId !== "string" || !/^[\w-]{1,100}$/.test(data.nodeId) || !Array.isArray(data.nodeIds) || data.nodeIds.length > 100 || data.nodeIds.some((id: unknown) => typeof id !== "string" || !/^[\w-]{1,100}$/.test(id))) return;
    message.nodeId = data.nodeId; message.nodeIds = [...data.nodeIds];
  }
  if (data.action === "edit") {
    if (![data.x,data.y].every(value=>typeof value === "number" && Number.isFinite(value) && Math.abs(value)<=10000) ||
      ![data.width,data.height].every(value=>typeof value === "number" && Number.isFinite(value) && value>0 && value<=10000)) return;
    message.x=data.x;message.y=data.y;message.width=data.width;message.height=data.height;
  }
  if (data.action === "gesture") {
    if (![data.dx, data.dy].every((value: unknown) => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 10000) ||
      ((data.width !== undefined || data.height !== undefined) && ![data.width, data.height].every((value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= 10000))) return;
    if(data.rotation!==undefined) {
      if(typeof data.rotation!=="number" || !Number.isFinite(data.rotation) || Math.abs(data.rotation)>360 || data.width!==undefined || data.nodeIds.length!==1)return;
      message.rotation=data.rotation;
    }
    message.dx = data.dx; message.dy = data.dy;
    if (data.width !== undefined) { message.width = data.width; message.height = data.height; }
  }
  if (data.action === "comment") {
    if (![data.x, data.y].every((value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100) ||
      (data.nodeId !== undefined && (typeof data.nodeId !== "string" || !/^[\w-]{1,100}$/.test(data.nodeId)))) return;
    message.x = data.x; message.y = data.y;
    if (data.nodeId !== undefined) message.nodeId = data.nodeId;
  }
  if (data.action === "annotation") {
    if (typeof data.annotationId !== "string" || !data.annotationId.length || data.annotationId.length > 2000) return;
    message.annotationId = data.annotationId;
  }
  if (["select", "comment", "error"].includes(data.action)) message.text = typeof data.text === "string" ? data.text.slice(0, 2000) : "";
  return message;
}
/** Click-through build order for entrance metadata: pause CSS entrances, release one per click. */
export const stepRevealScript = `(function(){'use strict';var items=[].slice.call(document.querySelectorAll('[data-design-enter]')).filter(function(n){return n.getAttribute('data-design-enter')!=='none';});
if(!items.length)return;var order=items.map(function(n){return{n:n,delay:Number(n.getAttribute('data-design-enter-delay'))||0};});
order.sort(function(a,b){return a.delay-b.delay||0;});order.forEach(function(item){item.n.style.animationPlayState='paused';});
var index=0;document.addEventListener('click',function(e){if(index>=order.length)return;e.preventDefault();e.stopPropagation();order[index++].n.style.animationPlayState='running';},true);})();`;
function bridge(generation: string, interactive: boolean, accent: string, comment: boolean, pageIds: string[]) {
  return `(function(){'use strict';var G=${json(generation)},TYPE=${json(DESIGN_BRIDGE)},play=${interactive},comment=${comment ? 'true' : 'false'},pageIds=${json(pageIds)},nodes=new Map(),selected=[],drag=null,box=null,skipClick=false;
  function send(action,extra){parent.postMessage(Object.assign({type:TYPE,generation:G,action:action},extra||{}),'*')}
  document.querySelectorAll('[data-design-id]').forEach(function(n){nodes.set(n.getAttribute('data-design-id'),n)});
  function valid(n){return n&&nodes.get(n.getAttribute('data-design-id'))===n&&n.isConnected}
  var marks=[],pinHost=document.createElement('div');pinHost.setAttribute('data-design-overlay','true');pinHost.style.cssText='all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;overflow:hidden!important';var pins=pinHost.attachShadow({mode:'closed'});document.documentElement.appendChild(pinHost);
  function drawPins(){var de=document.documentElement,w=de.scrollWidth,h=de.scrollHeight;pins.replaceChildren();marks.forEach(function(m,i){var b=document.createElement('button');b.type='button';b.textContent=String(i+1);b.title=m.text||'批注';b.setAttribute('aria-label','批注 '+(i+1)+(m.text?'：'+m.text:''));b.setAttribute('data-design-annotation',m.id);b.style.cssText='all:initial;box-sizing:border-box;position:absolute;display:grid;place-items:center;pointer-events:auto;cursor:pointer;width:24px;height:24px;border:2px solid white;border-radius:50%;background:'+${json(accent)}+';color:white;font:600 12px/1 sans-serif;box-shadow:0 2px 8px #0006;transform:translate(-50%,-50%);left:'+(Math.max(12,Math.min(w-12,m.x*w/100))-scrollX)+'px;top:'+(Math.max(12,Math.min(h-12,m.y*h/100))-scrollY)+'px';b.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();send('annotation',{annotationId:m.id})});pins.appendChild(b)})}
  function locked(n){return !!n.closest('[data-design-locked="true"]')}
  function draw(){drawPins();if(box)box.remove();if(play||comment||!selected.length)return;var n=nodes.get(selected[0]);if(!valid(n))return;var r=n.getBoundingClientRect();box=document.createElement('div');box.setAttribute('data-design-overlay','true');box.style.cssText='position:fixed;pointer-events:none;z-index:2147483647;border:2px solid '+${json(accent)}+';left:'+r.left+'px;top:'+r.top+'px;width:'+r.width+'px;height:'+r.height+'px';
  if(!locked(n)){var handle=document.createElement('button');handle.type='button';handle.setAttribute('aria-label','拖动调整大小');handle.style.cssText='position:absolute;right:-6px;bottom:-6px;width:12px;height:12px;padding:0;border:0;background:'+${json(accent)}+';pointer-events:auto;cursor:nwse-resize';handle.addEventListener('pointerdown',function(e){begin(e,n,true)});box.appendChild(handle);if(selected.length===1){var rotate=document.createElement('button');rotate.type='button';rotate.setAttribute('aria-label','拖动旋转');rotate.title='拖动旋转，Shift 对齐到 15°';rotate.style.cssText='position:absolute;left:calc(50% - 6px);top:-26px;width:12px;height:12px;padding:0;border:0;border-radius:50%;background:'+${json(accent)}+';pointer-events:auto;cursor:grab';rotate.addEventListener('pointerdown',function(e){begin(e,n,'rotate')});box.appendChild(rotate)}}document.body.appendChild(box)}
  function choose(n,multi){if(!valid(n)){selected=[];draw();send('select',{nodeId:'dynamic',nodeIds:[],text:'此节点由脚本生成，无法在静态源码中定位。'});return}var id=n.getAttribute('data-design-id');var members=[id],group=n.getAttribute('data-design-group');if(group&&/^[A-Za-z0-9_-]{1,100}$/.test(group))nodes.forEach(function(member,key){if(key!==id&&member.getAttribute('data-design-group')===group)members.push(key)});selected=multi?(members.every(function(key){return selected.includes(key)})?selected.filter(function(key){return !members.includes(key)}):Array.from(new Set(selected.concat(members)))):members;draw();send('select',{nodeId:id,nodeIds:selected,text:(n.textContent||'').slice(0,2000)})}
  function begin(e,n,resize){if(play||comment||locked(n)||e.button!==0)return;e.preventDefault();e.stopImmediatePropagation();var r=n.getBoundingClientRect();drag={x:e.clientX,y:e.clientY,n:n,id:n.getAttribute('data-design-id'),resize:resize===true,rotate:resize==='rotate',rotation:parseFloat(getComputedStyle(n).rotate)||0,cx:r.x+r.width/2,cy:r.y+r.height/2,angle:Math.atan2(e.clientY-r.y-r.height/2,e.clientX-r.x-r.width/2),w:r.width,h:r.height};if(e.target.setPointerCapture)try{e.target.setPointerCapture(e.pointerId)}catch(_){}}
  document.addEventListener('pointerdown',function(e){if(play||comment||e.target.closest('[data-design-overlay]'))return;var n=e.target.closest('[data-design-id]');if(!valid(n)||!selected.includes(n.getAttribute('data-design-id'))||e.shiftKey||e.ctrlKey||e.metaKey)return;begin(e,n,false)},true);
  function rotationAt(d,e){var delta=(Math.atan2(e.clientY-d.cy,e.clientX-d.cx)-d.angle)*180/Math.PI,angle=((d.rotation+delta+540)%360)-180;return e.shiftKey?Math.round(angle/15)*15:Math.round(angle*100)/100}
  document.addEventListener('pointermove',function(e){if(!drag||!box)return;if(drag.rotate){box.style.transform='rotate('+(rotationAt(drag,e)-drag.rotation)+'deg)';return}var dx=e.clientX-drag.x,dy=e.clientY-drag.y;box.style.transform='translate('+ (drag.resize?0:dx)+'px,'+(drag.resize?0:dy)+'px)';if(drag.resize){box.style.width=Math.max(1,drag.w+dx)+'px';box.style.height=Math.max(1,drag.h+dy)+'px'}});
  document.addEventListener('pointerup',function(e){if(!drag)return;var d=drag;drag=null;var dx=e.clientX-d.x,dy=e.clientY-d.y;if(Math.abs(dx)+Math.abs(dy)<3){draw();return}skipClick=true;setTimeout(function(){skipClick=false},0);send('gesture',{nodeId:d.id,nodeIds:d.resize||d.rotate?[d.id]:selected,dx:dx,dy:dy,rotation:d.rotate?rotationAt(d,e):undefined,width:d.resize?Math.max(1,d.w+dx):undefined,height:d.resize?Math.max(1,d.h+dy):undefined});draw()});
  document.addEventListener('pointercancel',function(){drag=null;draw()});
  document.addEventListener('click',function(e){if(skipClick){skipClick=false;e.preventDefault();e.stopImmediatePropagation();return}if(e.target.closest('[data-design-overlay]'))return;var jump=e.target.closest('a[data-design-page],button[data-design-page],a[href]'),target=jump&&(jump.getAttribute('data-design-page')||jump.getAttribute('href')||'').replace(/^#/,'');if(play&&pageIds.includes(target)){e.preventDefault();e.stopImmediatePropagation();send('navigate',{pageId:target});return}var link=e.target.closest('a');if(link&&link.getAttribute('href')&&!link.getAttribute('href').startsWith('#')){e.preventDefault();send('error',{text:'外部导航已阻止；预览只运行本地内联交互。'})}if(play)return;e.preventDefault();e.stopImmediatePropagation();if(comment){var de=document.documentElement,n=e.target.closest('[data-design-id]');send('comment',{x:Math.round((e.pageX/(de.scrollWidth||1))*10000)/100,y:Math.round((e.pageY/(de.scrollHeight||1))*10000)/100,nodeId:n&&valid(n)?n.getAttribute('data-design-id'):undefined,text:(e.target.textContent||'').slice(0,300)});return}choose(e.target.closest('[data-design-id]'),e.shiftKey||e.ctrlKey||e.metaKey)},true);
  document.addEventListener('dblclick',function(e){if(play||comment||e.target.closest('[data-design-overlay]'))return;var n=e.target.closest('[data-design-id]');if(!valid(n)||locked(n)||n.children.length||['INPUT','TEXTAREA','SELECT','IMG','VIDEO','AUDIO','CANVAS'].includes(n.tagName))return;e.preventDefault();e.stopImmediatePropagation();var r=n.getBoundingClientRect();send('edit',{nodeId:n.getAttribute('data-design-id'),nodeIds:[n.getAttribute('data-design-id')],x:r.x,y:r.y,width:r.width,height:r.height})},true);
  document.addEventListener('submit',function(e){e.preventDefault()},true);
  document.addEventListener('keydown',function(e){if(e.key==='Escape'){drag=null;selected=[];draw();send('clear')}});
  window.addEventListener('message',function(e){var d=e.data;if(e.source!==parent||!d||d.type!==TYPE||d.generation!==G)return;if(d.action==='hello'){send('ready');return}if(d.action==='annotations'){if(!Array.isArray(d.annotations)||d.annotations.length>200||d.annotations.some(function(m){return !m||typeof m.id!=='string'||!m.id.length||m.id.length>2000||typeof m.text!=='string'||m.text.length>2000||![m.x,m.y].every(function(v){return typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=100})}))return;marks=d.annotations.map(function(m){return {id:m.id,text:m.text,x:m.x,y:m.y}});drawPins();return}if(d.action!=='highlight'||!Array.isArray(d.nodeIds)||d.nodeIds.length>100||d.nodeIds.some(function(id){return typeof id!=='string'||!/^[\\w-]{1,100}$/.test(id)}))return;selected=d.nodeIds.filter(function(id){return valid(nodes.get(id))});draw()});
  window.addEventListener('resize',draw);window.addEventListener('scroll',draw,true);if(typeof ResizeObserver!=='undefined')new ResizeObserver(draw).observe(document.body);send('ready');})();`;
}
/** User source stays untouched. Trusted outer frame prevents child navigation to network URLs. */
export function buildDesignPreview(html: string, generation: string, interactive: boolean, tokens: Record<string, string>, comment = false, pageIds: string[] = [], stepReveal = false): string {
  const doc = parseDesignHtml(html), scripts = [...doc.querySelectorAll("script")].map(script => script.cloneNode(true));
  doc.querySelectorAll('script,base,meta[http-equiv],iframe,object,embed').forEach(node => node.remove());
  const policy = doc.createElement("meta"); policy.httpEquiv = "Content-Security-Policy"; policy.content = htmlPolicy(); doc.head.prepend(policy);
  const theme = doc.createElement("style"); theme.textContent = `:root{${Object.entries(tokens).filter(([key, value]) => /^--[\w-]+$/.test(key) && !/[<>;}]/.test(value)).map(([key, value]) => `${key}:${value}`).join(";")}}`; doc.head.appendChild(theme);
  if(!interactive){const staticMotion=doc.createElement("style");staticMotion.textContent='[data-design-enter]{animation:none!important}';doc.head.appendChild(staticMotion);}
  const glue = doc.createElement("script"); glue.textContent = bridge(generation, interactive, tokens["--accent"] || "Highlight", comment, pageIds); doc.body.appendChild(glue);
  if (stepReveal && interactive) { const reveal = doc.createElement("script"); reveal.textContent = stepRevealScript; doc.body.appendChild(reveal); }
  for (const script of scripts) doc.body.appendChild(script);
  const child = serializeDesignHtml(doc), outerPolicy = htmlPolicy().replace("frame-src 'none'", "frame-src 'self'");
  const relay = `(function(){var G=${json(generation)},T=${json(DESIGN_BRIDGE)};addEventListener('message',function(e){var d=e.data,f=document.querySelector('iframe');if(!d||d.type!==T||d.generation!==G||!f)return;if(e.source===parent&&['highlight','hello','annotations'].includes(d.action))f.contentWindow.postMessage(d,'*');else if(e.source===f.contentWindow&&['ready','select','edit','clear','gesture','comment','annotation','error','navigate'].includes(d.action))parent.postMessage(d,'*')})})();`;
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${escape(outerPolicy)}"><style>html,body{margin:0;height:100%;overflow:hidden}iframe{border:0;width:100%;height:100%;display:block}</style><script>${relay}</script></head><body><iframe title="设计页面内容" sandbox="allow-scripts" srcdoc="${escape(child)}"></iframe></body></html>`;
}
