import type { HtmlScene } from "@glintai/scenescript";
import { policyMeta } from "./html-policy";

export const GLINT_SEEK_MESSAGE_TYPE = "glint:seek";
export const GLINT_TIMELINE_GLOBAL = "__glintTimeline";
export const GSAP_SCRIPT_SRC = "gsap.min.js";

export function lottieFrameAt(seconds: number, data: {fr: number; ip: number; op: number}): number {
  if(!Number.isFinite(data.fr)||data.fr<=0||data.fr>240||!Number.isFinite(data.ip)||!Number.isFinite(data.op)||data.op<=data.ip)throw new Error("Invalid Lottie frame range");
  return Math.max(0,Math.min(Math.floor(data.op-data.ip)-1,Math.floor(seconds*data.fr+1e-6)));
}

/**
 * Sandbox protocol: the parent sends absolute seconds plus a document generation
 * and request ID. Only a successful seek with loaded resources earns an ack.
 * Timelines must be paused and declarative: no wall-clock or random side effects.
 */
function buildGlueSnippet(generation: string, mode = "gsap"): string {
  return `
(function () {
  "use strict";
  var MESSAGE_TYPE = ${JSON.stringify(GLINT_SEEK_MESSAGE_TYPE)};
  var TIMELINE_GLOBAL = ${JSON.stringify(GLINT_TIMELINE_GLOBAL)};
  var GENERATION = ${JSON.stringify(generation).replace(/</g, "\\u003c")};
  var timeline = null;
  var MODE = ${JSON.stringify(mode)};
  var renderer = null;
  var chain = Promise.resolve();
  var runtimeError = null;
  var lottieFrameAt = ${lottieFrameAt.toString()};
  var revision = 0;
  var loaded = new Promise(function (resolve) {
    if (document.readyState === "complete") resolve();
    else window.addEventListener("load", resolve, { once: true });
  });
  loaded.then(function () {
    window.parent.postMessage({ type: "glint:ready", generation: GENERATION }, "*");
  });
  function nextPaint() {
    return new Promise(function (resolve) { window.requestAnimationFrame(resolve); });
  }
  async function seek(seconds) {
    await loaded;
    if (MODE === "three") {
      if (!window.THREE || typeof window.__glintThree !== "function") throw new Error("Missing Three runtime or window.__glintThree factory");
      if (!timeline) {
        renderer = new THREE.WebGLRenderer({antialias:true,alpha:true,preserveDrawingBuffer:true});
        renderer.setPixelRatio(1); renderer.setSize(innerWidth,innerHeight);
        (document.getElementById("glint-root") || document.body).appendChild(renderer.domElement);
        timeline = window.__glintThree(THREE,{width:innerWidth,height:innerHeight});
        if (!timeline || !timeline.scene || !timeline.camera || typeof timeline.seek !== "function") throw new Error("Three factory must return scene, camera and seek(t)");
      }
      timeline.seek(seconds); renderer.render(timeline.scene,timeline.camera); renderer.getContext().finish();
    } else if (MODE === "lottie") {
      if (!window.lottie || !window.__glintLottie) throw new Error("Missing Lottie runtime or window.__glintLottie data");
      if (!timeline) {
        lottieFrameAt(0,window.__glintLottie);
        await Promise.all((window.__glintLottie.assets || []).filter(function(asset){return asset.p;}).map(async function(asset){
          if(asset.u || !new RegExp("^data:image/(png|jpeg|webp);base64,").test(asset.p))throw new Error("Only embedded Lottie PNG/JPEG/WebP images are allowed");
          var image=new Image();image.src=asset.p;await image.decode();
        }));
        timeline = lottie.loadAnimation({container:document.getElementById("glint-root") || document.body,renderer:"canvas",rendererSettings:{clearCanvas:true},loop:false,autoplay:false,animationData:window.__glintLottie});
        timeline.setSubframe(false);
        timeline.addEventListener("error",function(){runtimeError=new Error("Lottie render failed");});
        await new Promise(function(resolve,reject){ if(timeline.isLoaded) return resolve(); timeline.addEventListener("DOMLoaded",resolve); timeline.addEventListener("data_failed",function(){reject(new Error("Lottie data failed"));}); });
      }
      var data=window.__glintLottie;
      timeline.goToAndStop(0,true);
      timeline.goToAndStop(lottieFrameAt(seconds,data),true);
      if(runtimeError)throw runtimeError;
    } else {
    if (!window.gsap) throw new Error("gsap.min.js did not load");
    if (!timeline) {
      if (typeof window[TIMELINE_GLOBAL] !== "function") throw new Error("Missing window.__glintTimeline factory");
      timeline = window[TIMELINE_GLOBAL](window.gsap);
      if (!timeline || typeof timeline.pause !== "function" || typeof timeline.seek !== "function") {
        timeline = null;
        throw new Error("Timeline factory must return a paused GSAP timeline");
      }
    }
    try {
      // Absolute seeks and suppressed callbacks support repeated/out-of-order frames.
      timeline.pause(0).seek(seconds, true);
    } finally {
      window.gsap.ticker.sleep();
    }
    }
    if (document.fonts) {
      await document.fonts.ready;
      document.fonts.forEach(function (font) {
        if (font.status === "error") throw new Error("HTML font failed to load");
      });
    }
    await Promise.all(Array.from(document.images).map(async function (img) {
      if (typeof img.decode === "function") await img.decode();
      if (!img.complete || img.naturalWidth === 0) throw new Error("HTML image failed to load");
    }));
    // Let layout and the iframe compositor observe the seek before capture.
    await nextPaint();
    await nextPaint();
  }
  window.addEventListener("message", function (event) {
    var data = event.data;
    if (event.source !== window.parent || !data || data.type !== MESSAGE_TYPE ||
        data.generation !== GENERATION || !Number.isSafeInteger(data.requestId) ||
        data.requestId < 1 || typeof data.t !== "number" || !Number.isFinite(data.t) || data.t < 0) return;
    var current = ++revision;
    chain = chain.catch(function(){}).then(function(){ return seek(data.t); });
    chain.then(function () {
      if (current !== revision) return;
      window.parent.postMessage({ type: "glint:seeked", generation: GENERATION, requestId: data.requestId, t: data.t }, "*");
    }, function (error) {
      if (current !== revision) return;
      window.parent.postMessage({ type: "glint:seek-error", generation: GENERATION, requestId: data.requestId, t: data.t,
        error: String(error && error.message || error).slice(0, 500) }, "*");
    });
  });
})();
`;
}

/** Standalone snippet for protocol tests; production documents have a unique generation. */
export const GLINT_GLUE_SNIPPET = buildGlueSnippet("standalone");

/**
 * The runtime listens before user scripts execute. GSAP is served by each
 * channel's public mount via staticFile(); allow-scripts without
 * allow-same-origin keeps the iframe at an opaque origin.
 */
export function buildHtmlSceneDocument(
  scene: Pick<HtmlScene, "html" | "animation">,
  gsapSrc: string = GSAP_SCRIPT_SRC,
  generation = "standalone",
): string {
  if (!scene.animation) {
    throw new Error('buildHtmlSceneDocument is only for animation:"gsap" scenes; static scenes render their html verbatim');
  }
  return [
    "<!doctype html>", "<html>", "<head>", '<meta charset="utf-8">',
    policyMeta([gsapSrc]),
    `<script src="${gsapSrc.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")}"></script>`,
    `<script>${buildGlueSnippet(generation, scene.animation)}</script>`,
    "<style>html,body{margin:0;padding:0;height:100%}</style>",
    "</head>", "<body>", scene.html, "</body>", "</html>",
  ].join("\n");
}
