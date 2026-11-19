// Offline HTML deck delivery for page transitions and step reveal (S-03).
// Owns the deck bootstrap script; design-export-html.mjs only supplies data.
import { designTransitionLabels, presentTransition } from "../src/design-transition.ts";

const EASE = "cubic-bezier(.45,0,.25,1)";
const KEYFRAMES = {
  fade: "@keyframes glint-page-fade-in{from{opacity:0}to{opacity:1}}",
  push: "@keyframes glint-page-push-in{from{transform:translateX(100%)}to{transform:translateX(0)}}@keyframes glint-page-push-out{from{transform:translateX(0)}to{transform:translateX(-100%)}}",
  wipe: "@keyframes glint-page-wipe-in{from{clip-path:inset(0 100% 0 0)}to{clip-path:inset(0 0 0 0)}}",
  zoom: "@keyframes glint-page-zoom-in{from{opacity:0;transform:scale(1.12)}to{opacity:1;transform:scale(1)}}",
  none: "",
};
const IN_STYLE = {
  fade: "opacity:0;animation:glint-page-fade-in VAR both",
  push: "transform:translateX(100%);animation:glint-page-push-in VAR both",
  wipe: "clip-path:inset(0 100% 0 0);animation:glint-page-wipe-in VAR both",
  zoom: "opacity:0;transform:scale(1.12);animation:glint-page-zoom-in VAR both",
  none: "",
};

/** Keyframe sheet for the transition types actually used; reduced-motion readers switch instantly. */
export function deckTransitionSheet(pages) {
  const used = [...new Set(pages.map(page => presentTransition(page)?.type).filter(Boolean))];
  return `${used.map(type => KEYFRAMES[type]).join("")}@media (prefers-reduced-motion: reduce){.deck-frame,.page-overlay{animation:none!important;transform:none!important;clip-path:none!important;opacity:1!important}}`;
}
/** null for pages without an explicit transition; those switches stay instant like before. */
export function deckTransitionsJson(pages) {
  return JSON.stringify(pages.map(page => {
    const transition = presentTransition(page);
    return transition ? { type: transition.type, durationMs: transition.durationMs, label: designTransitionLabels[transition.type] } : null;
  }));
}
/** Page-level click-through reveal for exported pages that enable it. */
export const stepRevealInjection = `<script>(function(){'use strict';var items=[].slice.call(document.querySelectorAll('[data-design-enter]')).filter(function(n){return n.getAttribute('data-design-enter')!=='none';});if(!items.length)return;var order=items.map(function(n){return{n:n,delay:Number(n.getAttribute('data-design-enter-delay'))||0};});order.sort(function(a,b){return a.delay-b.delay;});order.forEach(function(item){item.n.style.animationPlayState='paused';});var index=0;document.addEventListener('click',function(e){if(index>=order.length)return;e.preventDefault();e.stopPropagation();order[index++].n.style.animationPlayState='running';},true);})();</script>`;

const overlayCss = ".deck-stage{position:relative;height:100%;min-height:0}.deck-frame,.page-overlay{position:absolute;inset:0;width:100%;height:100%;border:0;background:#fff}";
const PLAY_EASE = "cubic-bezier(.45,0,.25,1)";
/** The whole deck bootstrap: transitions overlay on top of the base frame; first paint and reduced motion stay instant. */
export function deckScript({ pagesJson, transitionsJson, stepScriptsJson, initialIndex, sourceJson }) {
  return `const pages=${pagesJson},transitions=${transitionsJson},stepScripts=${stepScriptsJson},base=document.getElementById('page'),stage=base.parentElement,sourceData=${sourceJson};
let overlay=null,active=-1,pending=null,guard=null;
function buttons(){document.querySelectorAll('[data-page]').forEach(b=>b.disabled=Number(b.dataset.page)===active)}
function seed(i){return stepScripts[i]?pages[i].replace('</body>',stepScripts[i]+'</body>'):pages[i]}
function settle(i){base.onload=()=>{base.onload=null;if(overlay){overlay.remove();overlay=null}};base.srcdoc=seed(i);active=i;buttons();location.hash='design-page-'+i}
function clearMotion(){if(pending){clearTimeout(pending);pending=null}if(guard){clearTimeout(guard);guard=null}base.style.animation=''}
function show(i){if(!Number.isInteger(i)||!pages[i]||i===active)return;
  if(pending)clearMotion();
  const info=transitions[i];
  if(!info||window.matchMedia('(prefers-reduced-motion: reduce)').matches){settle(i);return}
  const keyframes=(info.type==='push'?'@keyframes glint-page-push-out{from{transform:translateX(0)}to{transform:translateX(-100%)}}':'')+'@keyframes glint-page-play{'+(info.type==='fade'?'from{opacity:0}to{opacity:1}':info.type==='push'?'from{transform:translateX(100%)}to{transform:translateX(0)}':info.type==='wipe'?'from{clip-path:inset(0 100% 0 0)}to{clip-path:inset(0 0 0 0)}':'from{opacity:0;transform:scale(1.12)}to{opacity:1;transform:scale(1)}')+'}';
  document.getElementById('deck-motion').textContent=keyframes;
  if(!overlay){overlay=document.createElement('iframe');overlay.className='page-overlay';overlay.title='页面转场';overlay.setAttribute('sandbox','allow-scripts');stage.appendChild(overlay)}
  overlay.style.animation='';overlay.style.visibility='hidden';
  overlay.onload=()=>{if(!overlay)return;overlay.onload=null;overlay.style.visibility='';
    overlay.style.animation='glint-page-play '+info.durationMs+'ms ${PLAY_EASE} both';
    if(info.type==='push')base.style.animation='glint-page-push-out '+info.durationMs+'ms ${PLAY_EASE} both';
    pending=setTimeout(()=>{pending=null;clearMotion();settle(i)},info.durationMs+60)};
  overlay.srcdoc=seed(i);
  guard=setTimeout(()=>{if(pending){clearTimeout(pending);pending=null;settle(i)}},info.durationMs+2500);
}
document.querySelector('nav').onclick=e=>{if(e.target.dataset.page!==undefined)show(Number(e.target.dataset.page))};
window.addEventListener('message',e=>{if(base&&e.source===base.contentWindow&&e.data?.type==='glint-design-page')show(e.data.page)});
window.addEventListener('hashchange',()=>show(Number(location.hash.replace('#design-page-',''))));
document.getElementById('source').onclick=()=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(sourceData,null,1)],{type:'application/json'}));a.download='design-source.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)};
show(${initialIndex});`;
}

