import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";
import type { Scene } from "@glintai/scenescript";
import { renderSceneSvg } from "../native-svg";
import type { SceneScriptProject } from "@glintai/scenescript";
import { resolveTheme } from "@glintai/design-tokens";
import { cameraTransform, beatPulseScale, sceneDurationMs, transitionStyle, flashOverlayOpacity, sourceTimeForFrame, effectFilterSvg, DEFAULT_TRANSITION_MS } from "@glintai/scenescript";
import { buildHtmlSceneDocument } from "../../../../packages/video/src/scenes/html-runtime";
import { isolatedHtmlFrame, staticHtmlDocument } from "../../../../packages/video/src/scenes/html-policy";

type Runtime = { seek(frame: number): Promise<void>; dispose(): void };
const state = window as unknown as { __glintInit(project: SceneScriptProject, scene: Scene, plate?: boolean): Promise<void>; __glintSeek(frame: number): Promise<void>; __glintReady?: boolean };
let runtime: Runtime | undefined;
let project: SceneScriptProject;
let scene: Scene;
let visual: HTMLDivElement;
let overlay: HTMLDivElement;
let flash: HTMLDivElement;
let effectStage: HTMLDivElement;
let effectDefinitions: SVGSVGElement;
let effectBackdrop: HTMLDivElement;
let plate = false;

const waitMedia = (element: HTMLMediaElement | HTMLImageElement, event: string) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => { cleanup(); reject(new Error("Media readiness timeout")); }, 15000);
  const ok = () => { cleanup(); resolve(); }, fail = () => { cleanup(); reject(new Error("Media failed to load")); };
  const cleanup = () => { clearTimeout(timer); element.removeEventListener(event, ok); element.removeEventListener("error", fail); };
  element.addEventListener(event, ok, { once: true }); element.addEventListener("error", fail, { once: true });
});

async function htmlRuntime(value: Extract<Scene, { kind: "html" }>): Promise<Runtime> {
  const generation = crypto.randomUUID(), frame = document.createElement("iframe");
  frame.sandbox.add("allow-scripts"); frame.style.cssText = "position:absolute;inset:0;width:100%;height:100%;border:0";
  const script = `${location.origin}/${value.animation === "three" ? "three.runtime.js" : value.animation === "lottie" ? "lottie_light.min.js" : "gsap.min.js"}`;
  frame.srcdoc = isolatedHtmlFrame(value.animation ? buildHtmlSceneDocument(value, script, generation) : staticHtmlDocument(value.html), generation, Boolean(value.animation), value.animation ? script : undefined);
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { window.removeEventListener("message", listener); reject(new Error("HTML initialization timed out")); }, 15000);
    const listener = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow || event.data?.generation !== generation || event.data?.type !== "glint:ready") return;
      clearTimeout(timer); window.removeEventListener("message", listener); resolve();
    };
    if (value.animation) window.addEventListener("message", listener);
    else frame.onload = () => { clearTimeout(timer); resolve(); };
  });
  visual.append(frame); await ready;
  let requestId = 0;
  return {
    async seek(f) {
      if (!value.animation) return;
      const id = ++requestId, t = f / (project.fps ?? 30);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); reject(new Error("HTML seek timed out")); }, 15000);
        const cleanup = () => { clearTimeout(timer); window.removeEventListener("message", listener); };
        const listener = (event: MessageEvent) => {
          if (event.source !== frame.contentWindow || event.data?.generation !== generation || event.data?.requestId !== id || event.data?.t !== t) return;
          if (event.data.type === "glint:seek-error") { cleanup(); reject(new Error(String(event.data.error))); }
          if (event.data.type === "glint:seeked") { cleanup(); resolve(); }
        };
        window.addEventListener("message", listener); frame.contentWindow!.postMessage({ type: "glint:seek", generation, requestId: id, t }, "*");
      });
    },
    dispose() { frame.remove(); },
  };
}

async function threeRuntime(value: Extract<Scene, { kind: "three" }>): Promise<Runtime> {
  const theme = resolveTheme(project.theme), c = theme.colors;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setSize(innerWidth, innerHeight); renderer.setPixelRatio(1); renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; visual.append(renderer.domElement);
  const root = new THREE.Scene(), camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.01, 1000);
  camera.position.set(0, 0, 5.6); root.add(new THREE.HemisphereLight(0xffffff, 0x333333, 1));
  const main = new THREE.DirectionalLight(c.text, 2); main.position.set(4, 6, 6); root.add(main);
  const rim = new THREE.DirectionalLight(c.accent2, 2); rim.position.set(-6, -2, -4); root.add(rim);
  const group = new THREE.Group(); root.add(group);
  let mixer: THREE.AnimationMixer | undefined;
  const draco = new DRACOLoader().setDecoderPath(`${location.origin}/decoders/draco/`);
  const ktx = new KTX2Loader().setTranscoderPath(`${location.origin}/decoders/basis/`).detectSupport(renderer);
  if (value.model === "gltf") {
    const loader = new GLTFLoader().setDRACOLoader(draco).setKTX2Loader(ktx);
    const gltf = await loader.loadAsync(`${location.origin}/${value.src}`);
    const box = new THREE.Box3().setFromObject(gltf.scene), size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
    const extent = Math.max(size.x, size.y, size.z);
    if (!Number.isFinite(extent) || extent <= 0) throw new Error("glTF has no finite visible bounds");
    gltf.scene.position.sub(center); group.scale.setScalar(3 / extent); group.add(gltf.scene);
    mixer = new THREE.AnimationMixer(gltf.scene); for (const clip of gltf.animations) mixer.clipAction(clip).play();
  } else {
    const geometry = value.model === "sphere" ? new THREE.SphereGeometry(1.5, 64, 48) : value.model === "icosahedron" ? new THREE.IcosahedronGeometry(1.5, 0) : new THREE.TorusKnotGeometry(1.02, 0.32, 192, 32);
    group.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: c.accent, metalness: 0.82, roughness: 0.18, emissive: c.accent2, emissiveIntensity: 0.08, flatShading: value.model === "icosahedron" })));
  }
  return {
    async seek(f) { const t = f / (project.fps ?? 30); if (mixer) mixer.setTime(t); else group.rotation.set(t * 0.32, t * 0.52, 0); renderer.render(root, camera); renderer.getContext().finish(); },
    dispose() { draco.dispose(); ktx.dispose(); mixer?.stopAllAction(); root.traverse((object: THREE.Object3D) => { const mesh = object as THREE.Mesh; mesh.geometry?.dispose?.(); const material = mesh.material as THREE.Material | THREE.Material[] | undefined; const list = Array.isArray(material) ? material : material ? [material] : []; for (const item of list) { for (const texture of Object.values(item).filter((entry): entry is THREE.Texture => entry instanceof THREE.Texture)) texture.dispose(); item.dispose(); } }); renderer.dispose(); renderer.domElement.remove(); },
  };
}

state.__glintInit = async (p, s, cleanPlate = false) => {
  runtime?.dispose(); runtime = undefined; project = p; scene = s; plate = cleanPlate;
  document.body.replaceChildren(); document.body.style.cssText = `margin:0;overflow:hidden;background:${resolveTheme(p.theme).colors.bg}`;
  visual = document.createElement("div"); visual.style.cssText = "position:absolute;inset:0;transform-origin:center;overflow:hidden";
  overlay = document.createElement("div"); overlay.style.cssText = "position:absolute;inset:0;pointer-events:none";
  flash = document.createElement("div"); flash.style.cssText = "position:absolute;inset:0;background:white;pointer-events:none;opacity:0";
  effectStage = document.createElement("div");
  effectStage.style.cssText = `position:absolute;inset:0;background:${resolveTheme(p.theme).colors.bg}`;
  effectDefinitions = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  effectDefinitions.setAttribute("width", "0"); effectDefinitions.setAttribute("height", "0");
  effectDefinitions.style.cssText = "position:absolute;pointer-events:none";
  effectBackdrop = document.createElement("div");
  effectBackdrop.style.cssText = "position:absolute;inset:0;pointer-events:none";
  effectStage.append(visual, flash, overlay, effectBackdrop); document.body.append(effectDefinitions, effectStage);
  if (s.kind === "html") runtime = await htmlRuntime(s);
  else if (s.kind === "three") runtime = await threeRuntime(s);
  else if (s.kind === "image") {
    const image = new Image(); image.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:contain";
    const ready = waitMedia(image, "load"); image.src = `${location.origin}/${s.src}`; visual.append(image); await ready;
    runtime = { async seek() {}, dispose() { image.remove(); } };
  } else if (s.kind === "video") {
    const video = document.createElement("video"); video.muted = true; video.preload = "auto"; video.style.cssText = "width:100%;height:100%;object-fit:cover";
    const ready = waitMedia(video, "loadeddata"); video.src = `${location.origin}/${s.src}`; visual.append(video); await ready;
    if (!(video.duration > 0)) throw new Error("Video has no valid duration");
    runtime = {
      async seek(f) { const end = Math.min(video.duration, s.trimEndSec ?? video.duration); const start = s.trimStartSec ?? 0; if (start >= end) throw new Error("Video trim start must precede trim end"); const t = Math.min(end - 0.001, Math.max(start, sourceTimeForFrame(f, p.fps ?? 30, { speed: s.speed, trimStartSec: start }))); if (Math.abs(video.currentTime - t) > 0.0001) { const seek = waitMedia(video, "seeked"); video.currentTime = t; await seek; } },
      dispose() { video.pause(); video.removeAttribute("src"); video.load(); video.remove(); },
    };
  } else {
    const image = new Image(); image.style.cssText = "width:100%;height:100%;position:absolute;inset:0"; document.body.append(image);
    let url = "";
    runtime = { async seek(f) { if (url) URL.revokeObjectURL(url); url = URL.createObjectURL(new Blob([renderSceneSvg(p, s, f, { width: innerWidth, height: innerHeight })], { type: "image/svg+xml" })); image.src = url; await image.decode(); }, dispose() { if (url) URL.revokeObjectURL(url); image.remove(); } };
  }
};
state.__glintSeek = async frame => {
  if (!runtime) throw new Error("Initialize a scene before seeking");
  await runtime.seek(frame); await document.fonts.ready;
  if (["html", "three", "image", "video"].includes(scene.kind)) {
    const fps = project.fps ?? 30, duration = Math.max(1, Math.round(sceneDurationMs(scene) / 1000 * fps));
    const camera = cameraTransform(scene.camera, frame, duration);
    const scale = camera.scale * beatPulseScale(scene.beatPulse, frame / fps * 1000);
    const p = Math.min(1, frame / fps * 1000 / (scene.transition?.durationMs ?? DEFAULT_TRANSITION_MS));
    const entrance = scene.transition ? transitionStyle(scene.transition.in, p) : { opacity: 1, transform: "none", filter: "none", clipPath: "none" };
    visual.style.transform = `${entrance.transform === "none" ? "" : entrance.transform} translate(${camera.translateX}px,${camera.translateY}px) scale(${scale})`;
    visual.style.opacity = String(entrance.opacity); visual.style.filter = entrance.filter; visual.style.clipPath = entrance.clipPath;
    flash.style.opacity = String(scene.transition ? flashOverlayOpacity(scene.transition.in, p) : 0);
    const captionScene = { id: scene.id, kind: "title" as const, title: "", narration: scene.narration, sharedElements: scene.sharedElements };
    overlay.innerHTML = renderSceneSvg(project, captionScene, frame, { width: innerWidth, height: innerHeight, plate, overlayOnly: true });
    const filter = effectFilterSvg(scene.effects ?? [], frame / fps * 1000, "direct-scene");
    effectDefinitions.innerHTML = filter.defs;
    // Chromium skips reference filters on opaque-origin iframe descendants.
    // A topmost backdrop layer filters their composited pixels with the same SVG.
    effectStage.style.filter = scene.kind === "html" ? "none" : filter.filter;
    effectBackdrop.style.backdropFilter = scene.kind === "html" ? filter.filter : "none";
  }
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
};
state.__glintReady = true;
