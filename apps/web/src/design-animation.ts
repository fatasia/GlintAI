export type DesignEntrance={type:'none'|'fade'|'rise'|'zoom';durationMs:number;delayMs:number};
export const DESIGN_MOTION_STYLE='data-glint-design-motion';
export function readDesignEntrance(element:Element):DesignEntrance{
 const type=element.getAttribute('data-design-enter')??'none',durationMs=Number(element.getAttribute('data-design-enter-duration')??600),delayMs=Number(element.getAttribute('data-design-enter-delay')??0);
 if(!['none','fade','rise','zoom'].includes(type)||!Number.isInteger(durationMs)||durationMs<100||durationMs>5000||!Number.isInteger(delayMs)||delayMs<0||delayMs>10000)throw new Error('入场动画参数无效，时长需为 100–5000ms，延迟需为 0–10000ms。');
 return{type:type as DesignEntrance['type'],durationMs,delayMs};
}
const motionCss=`@keyframes glint-design-fade{from{opacity:0}to{opacity:1}}@keyframes glint-design-rise{from{opacity:0;translate:0 32px}to{opacity:1;translate:0 0}}@keyframes glint-design-zoom{from{opacity:0;scale:.9}to{opacity:1;scale:1}}[data-design-enter="fade"]{animation-name:glint-design-fade}[data-design-enter="rise"]{animation-name:glint-design-rise}[data-design-enter="zoom"]{animation-name:glint-design-zoom}[data-design-enter]:not([data-design-enter="none"]){animation-duration:var(--glint-enter-duration,600ms);animation-delay:var(--glint-enter-delay,0ms);animation-timing-function:ease-out;animation-fill-mode:both;animation-iteration-count:1}`;
function managedStyles(document:Document):Element[]{
 const styles=[...document.querySelectorAll(`style[${DESIGN_MOTION_STYLE}]`)];
 if(styles.some(style=>style.textContent!==motionCss))throw new Error('入场动画样式已被源码修改，请先移除 data-glint-design-motion 标记并保留自定义样式，再设置动画。');
 return styles;
}
export function patchDesignEntrance(document:Document,element:HTMLElement,value:DesignEntrance):void{
 const styles=managedStyles(document);
 if(value.type==='none'){for(const key of ['data-design-enter','data-design-enter-duration','data-design-enter-delay'])element.removeAttribute(key);element.style.removeProperty('--glint-enter-duration');element.style.removeProperty('--glint-enter-delay');}
 else{element.setAttribute('data-design-enter',value.type);element.setAttribute('data-design-enter-duration',String(value.durationMs));element.setAttribute('data-design-enter-delay',String(value.delayMs));readDesignEntrance(element);element.style.setProperty('--glint-enter-duration',`${value.durationMs}ms`);element.style.setProperty('--glint-enter-delay',`${value.delayMs}ms`);}
 styles.forEach(style=>style.remove());
 if(document.querySelector('[data-design-enter]')){const style=document.createElement('style');style.setAttribute(DESIGN_MOTION_STYLE,'true');style.textContent=motionCss;document.head.appendChild(style);}
}
/** Natural element state reached after the entrance; opacity null means "clear inline style". */
export type EntranceFrame={opacity:number|null;transform:string|null};
/**
 * Pure position solver shared by every delivery surface: opacity/transform at tMs,
 * matching the shipped rise/zoom timing (quad ease-out, from-state held until the
 * delay elapses, natural state restored after). No wall clock, no randomness.
 */
export function styleAt(entrance:DesignEntrance,tMs:number):EntranceFrame{
 if(!Number.isFinite(tMs)||tMs<0)throw new Error('动画时间必须是不小于 0 的毫秒数。');
 const local=(tMs-entrance.delayMs)/entrance.durationMs;
 const from=entrance.type==='rise'?'translateY(32px)':entrance.type==='zoom'?'scale(0.9)':'';
 if(local<=0)return{opacity:0,transform:from};
 if(local>=1)return{opacity:null,transform:null};
 const eased=1-(1-local)*(1-local);
 const transform=entrance.type==='rise'?`translateY(${(32*(1-eased)).toFixed(3)}px)`:entrance.type==='zoom'?`scale(${(0.9+0.1*eased).toFixed(4)})`:'';
 return{opacity:eased,transform:transform||null};
}
/** Trusted deterministic timeline from bounded metadata; no user-supplied JavaScript. */
export function designEntranceTimeline(document:Document):string|null{
 const items=[...document.body.querySelectorAll('[data-design-enter]')].map(element=>{const id=element.getAttribute('data-design-id');if(!id||!/^[A-Za-z0-9_-]{1,100}$/.test(id))throw new Error('动画对象缺少稳定编号。');return{id,...readDesignEntrance(element)};}).filter(item=>item.type!=='none');
 if(!items.length)return null;if(items.length>200)throw new Error('单页动画对象不能超过 200 个。');
 managedStyles(document).forEach(style=>style.remove());
 const data=JSON.stringify(items).replace(/</g,'\\u003c');
 return `window.__glintTimeline=function(){var items=${data}.map(function(item){var node=document.querySelector('[data-design-id="'+item.id+'"]');if(!node)throw new Error('Missing animation target');return Object.assign(item,{base:Number(getComputedStyle(node).opacity)||1});});
 var timeline={pause:function(){return timeline;},seek:function(seconds){var tMs=seconds*1000;items.forEach(function(item){var node=document.querySelector('[data-design-id="'+item.id+'"]');if(!node)throw new Error('Missing animation target');var frame=glintStyleAt(item,tMs);
 if(frame.opacity===null)node.style.removeProperty('opacity');else node.style.opacity=String(Math.min(1,frame.opacity*item.base));
 if(frame.transform===null)node.style.removeProperty('transform');else node.style.transform=frame.transform;});return timeline;}};
 return timeline;};
 function glintStyleAt(entrance,tMs){var local=(tMs-entrance.delayMs)/entrance.durationMs;var from=entrance.type==='rise'?'translateY(32px)':entrance.type==='zoom'?'scale(0.9)':'';
 if(local<=0)return{opacity:0,transform:from};
 if(local>=1)return{opacity:null,transform:null};
 var eased=1-(1-local)*(1-local);
 return{opacity:eased,transform:entrance.type==='rise'?'translateY('+(32*(1-eased)).toFixed(3)+'px)':entrance.type==='zoom'?'scale('+(0.9+0.1*eased).toFixed(4)+')':null};}`;
}
