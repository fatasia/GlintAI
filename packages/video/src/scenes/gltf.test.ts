import fs from "node:fs";
import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachGltfDecoders, createGltfMixer, detectDecoderNeeds, disposeGltf, DRACO_DECODER_PATH,
  fitGltf, fittedCameraDistance, KTX2_TRANSCODER_PATH, loadLocalGltf, resetGltfDecoderPool,
  seekGltfAnimation, type DecoderNeeds,
} from "./gltf";

const fixture = new URL("../../../../examples/local-media/assets/models/", import.meta.url);
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// Image decoding is mocked in Node; buffer parsing, meshes and animations are real GLTFLoader.
async function parseFixture(file: string) {
  vi.stubGlobal("self", globalThis);
  vi.stubGlobal("ProgressEvent", class extends Event { constructor(type: string) { super(type); } });
  vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 2, height: 2, close() {} })));
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (url === "cube.bin") return `data:application/octet-stream;base64,${fs.readFileSync(new URL(url, fixture)).toString("base64")}`;
    if (url === "textures/checker.png") return `data:image/png;base64,${fs.readFileSync(new URL(url, fixture)).toString("base64")}`;
    return url;
  });
  const bytes = fs.readFileSync(new URL(file, fixture));
  return new GLTFLoader(manager).parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "");
}

/** Stubs the browser globals loadLocalGltf/GLTFLoader need and serves models/ files (or a custom responder) over same-origin http. */
function stubBrowserAndFetch(serve?: (url: string) => Response | undefined) {
  vi.stubGlobal("self", globalThis);
  vi.stubGlobal("window", { location: { href: "http://localhost:3000/", origin: "http://localhost:3000" } });
  vi.stubGlobal("ProgressEvent", class extends Event { constructor(type: string) { super(type); } });
  vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 2, height: 2, close() {} })));
  const nativeFetch = globalThis.fetch;
  const nativeCreate = URL.createObjectURL;
  const nativeRevoke = URL.revokeObjectURL;
  const browserBlobs = new Map<string, string>();
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    const native = nativeCreate(blob);
    const browser = `blob:http://localhost:3000/${browserBlobs.size}`;
    browserBlobs.set(browser, native);
    return browser;
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => { nativeRevoke(browserBlobs.get(url) ?? url); });
  const localFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const custom = serve?.(url);
    if (custom) return custom;
    if (url.startsWith("http://localhost:3000/assets/models/")) {
      const name = url.slice("http://localhost:3000/assets/models/".length);
      return new Response(fs.readFileSync(new URL(name, fixture)));
    }
    if (browserBlobs.has(url)) return nativeFetch(browserBlobs.get(url)!, init);
    if (input instanceof Request && browserBlobs.has(input.url)) return nativeFetch(browserBlobs.get(input.url)!, init);
    return nativeFetch(input, init);
  });
  vi.stubGlobal("fetch", localFetch);
  return localFetch;
}

/** Minimal DRACO-compressed document that reaches mesh loading (GLTFLoader then fails on the missing decoder). */
const dracoDocument = {
  asset: { version: "2.0" },
  extensionsUsed: ["KHR_draco_mesh_compression"],
  extensionsRequired: ["KHR_draco_mesh_compression"],
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0 }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 }, extensions: { KHR_draco_mesh_compression: { bufferView: 0, attributes: { POSITION: 0 } } } }] }],
  accessors: [{ componentType: 5126, count: 3, type: "VEC3" }],
  bufferViews: [{ buffer: 0 }],
  buffers: [{ byteLength: 36 }],
};

describe("glTF rendering primitives", () => {
  it.each(["cube.gltf", "cube.glb"])("parses authored %s with real GLTFLoader", async (file) => {
    const gltf = await parseFixture(file);
    expect(gltf.scene.getObjectByName("AuthoredCube")).toBeInstanceOf(THREE.Mesh);
    expect(gltf.animations[0]?.name).toBe("Turn");
    const fit = fitGltf(gltf.scene);
    const group = new THREE.Group(); group.scale.setScalar(fit.scale); group.position.copy(fit.position); group.add(gltf.scene);
    const bounds = new THREE.Box3().setFromObject(group);
    expect(bounds.getCenter(new THREE.Vector3()).length()).toBeLessThan(1e-6);
    expect(bounds.getSize(new THREE.Vector3()).x).toBeCloseTo(2.8);
    disposeGltf(gltf);
  });
  it("seeks animation absolutely across out-of-order and repeated frames", async () => {
    const gltf = await parseFixture("cube.glb");
    const mixer = createGltfMixer(gltf);
    const node = gltf.scene.getObjectByName("AuthoredCube")!;
    seekGltfAnimation(mixer, 15, 30); const at15 = node.quaternion.toArray();
    expect(Math.abs(node.quaternion.y)).toBeGreaterThan(0);
    for (const frame of [55, 0, 15, 15, 95, 15]) {
      seekGltfAnimation(mixer, frame, 30);
      if (frame === 15) expect(node.quaternion.toArray()).toEqual(at15);
    }
    seekGltfAnimation(mixer, 0, 30);
    expect(node.quaternion.toArray()).toEqual([0, 0, 0, 1]);
    mixer.stopAllAction(); mixer.uncacheRoot(gltf.scene); disposeGltf(gltf);
  });
  it.each([16 / 9, 9 / 16, 1])("fits centered model within camera aspect %s", (aspect) => {
    const camera = new THREE.PerspectiveCamera(40, aspect, .1, 100);
    camera.position.z = fittedCameraDistance(aspect); camera.updateMatrixWorld();
    for (const x of [-1.4, 1.4]) for (const y of [-1.4, 1.4]) for (const z of [-1.4, 1.4]) {
      const point = new THREE.Vector3(x, y, z).project(camera);
      expect(Math.abs(point.x)).toBeLessThan(1); expect(Math.abs(point.y)).toBeLessThan(1);
    }
  });
  it("rejects empty/nonfinite model bounds", () => {
    expect(() => fitGltf(new THREE.Group())).toThrow(/bounds/);
  });
  it("disposes shared geometry, materials, textures and image bitmaps only once", () => {
    class Bitmap { close = vi.fn(); }
    vi.stubGlobal("ImageBitmap", Bitmap);
    const bitmap = new Bitmap(); const texture = new THREE.Texture(bitmap as unknown as ImageBitmap);
    const geometry = new THREE.BoxGeometry(); const material = new THREE.MeshStandardMaterial({ map: texture, emissiveMap: texture });
    const scene = new THREE.Group(); scene.add(new THREE.Mesh(geometry, material), new THREE.Mesh(geometry, material));
    const calls = [vi.spyOn(texture, "dispose"), vi.spyOn(geometry, "dispose"), vi.spyOn(material, "dispose"), bitmap.close];
    disposeGltf({ scenes: [scene, scene] });
    for (const call of calls) expect(call).toHaveBeenCalledTimes(1);
  });
});

describe("decoder needs detection", () => {
  it("reads extensionsUsed/Required and ignores unrelated extensions", () => {
    expect(detectDecoderNeeds({ asset: { version: "2.0" } })).toEqual({});
    expect(detectDecoderNeeds({ extensionsUsed: ["KHR_draco_mesh_compression"] })).toEqual({ draco: true });
    expect(detectDecoderNeeds({ extensionsUsed: ["VRMC_materials_mtoon"], extensionsRequired: ["KHR_texture_basisu"] })).toEqual({ ktx2: true });
    expect(detectDecoderNeeds({ extensionsUsed: ["KHR_draco_mesh_compression"], extensionsRequired: ["KHR_texture_basisu"] })).toEqual({ draco: true, ktx2: true });
  });
  it("detects nested primitive/texture extensions even when unlisted", () => {
    expect(detectDecoderNeeds({ meshes: [{ primitives: [{ attributes: {}, extensions: { KHR_draco_mesh_compression: {} } }] }] })).toEqual({ draco: true });
    expect(detectDecoderNeeds({ textures: [{ extensions: { KHR_texture_basisu: { source: 0 } } }] })).toEqual({ ktx2: true });
    expect(detectDecoderNeeds({ meshes: [{ primitives: [{ extensions: { EXT_meshopt_compression: {} } }] }] })).toEqual({});
  });
});

describe("decoder attachment", () => {
  beforeEach(() => resetGltfDecoderPool());
  const stubLoader = () => ({ setDRACOLoader: vi.fn(), setKTX2Loader: vi.fn() });
  const stubFactories = () => {
    const draco = { setDecoderPath: vi.fn() };
    const ktx2 = { setTranscoderPath: vi.fn(), detectSupport: vi.fn() };
    return { factories: { draco: vi.fn(async () => draco), ktx2: vi.fn(async () => ktx2) }, draco, ktx2 };
  };
  it("attaches only needed decoders at the hosted paths", async () => {
    expect(DRACO_DECODER_PATH).toBe("decoders/draco/");
    expect(KTX2_TRANSCODER_PATH).toBe("decoders/basis/");
    const loader = stubLoader();
    const { factories, draco, ktx2 } = stubFactories();
    const renderer = { capabilities: {} } as unknown as THREE.WebGLRenderer;
    await attachGltfDecoders(loader, { draco: true, ktx2: true }, renderer, factories);
    expect(draco.setDecoderPath).toHaveBeenCalledWith(DRACO_DECODER_PATH);
    expect(loader.setDRACOLoader).toHaveBeenCalledWith(draco);
    expect(ktx2.setTranscoderPath).toHaveBeenCalledWith(KTX2_TRANSCODER_PATH);
    expect(ktx2.detectSupport).toHaveBeenCalledWith(renderer);
    expect(loader.setKTX2Loader).toHaveBeenCalledWith(ktx2);
  });
  it("creates nothing when the model needs no decoders", async () => {
    const loader = stubLoader();
    const { factories, draco, ktx2 } = stubFactories();
    await attachGltfDecoders(loader, {}, null, factories);
    expect(factories.draco).not.toHaveBeenCalled();
    expect(factories.ktx2).not.toHaveBeenCalled();
    expect(loader.setDRACOLoader).not.toHaveBeenCalled();
    expect(loader.setKTX2Loader).not.toHaveBeenCalled();
  });
  it("reuses pooled instances across loads and re-detects a new renderer", async () => {
    const first = stubLoader();
    const second = stubLoader();
    const { factories, draco, ktx2 } = stubFactories();
    const rendererA = {} as THREE.WebGLRenderer;
    const rendererB = {} as THREE.WebGLRenderer;
    await attachGltfDecoders(first, { draco: true, ktx2: true }, rendererA, factories);
    await attachGltfDecoders(second, { draco: true, ktx2: true }, rendererA, factories);
    expect(factories.draco).toHaveBeenCalledTimes(1);
    expect(factories.ktx2).toHaveBeenCalledTimes(1);
    expect(draco.setDecoderPath).toHaveBeenCalledTimes(2);
    expect(ktx2.detectSupport).toHaveBeenCalledTimes(1);
    await attachGltfDecoders(second, { ktx2: true }, rendererB, factories);
    expect(ktx2.detectSupport).toHaveBeenCalledTimes(2);
    expect(ktx2.detectSupport).toHaveBeenLastCalledWith(rendererB);
  });
  it("refuses KTX2 without a renderer before creating the transcoder", async () => {
    const loader = stubLoader();
    const { factories, ktx2 } = stubFactories();
    await expect(attachGltfDecoders(loader, { ktx2: true }, null, factories)).rejects.toThrow(/renderer/);
    expect(factories.ktx2).not.toHaveBeenCalled();
    expect(loader.setKTX2Loader).not.toHaveBeenCalled();
  });
  it("resolves decoder directories through the channel's public mount", async () => {
    const loader = stubLoader();
    const { factories, draco, ktx2 } = stubFactories();
    const renderer = {} as THREE.WebGLRenderer;
    await attachGltfDecoders(loader, { draco: true, ktx2: true }, renderer, factories, (file) => `/static-bundle/${file}`);
    expect(draco.setDecoderPath).toHaveBeenCalledWith("/static-bundle/decoders/draco/");
    expect(ktx2.setTranscoderPath).toHaveBeenCalledWith("/static-bundle/decoders/basis/");
  });
});

describe("local model loading failures", () => {
  it("maps KTX2 extension resources to prefetched blobs even with a separate loader manager", async () => {
    stubBrowserAndFetch();const urls:string[]=[];
    const gltf=await loadLocalGltf('/assets/models/cube-ktx2.gltf',new AbortController().signal,{setupDecoders:loader=>{
      loader.setKTX2Loader({load:(url:string,onLoad:(texture:THREE.Texture)=>void)=>{urls.push(url);onLoad(new THREE.Texture())}} as never);
    }});
    expect(urls).toHaveLength(1);expect(urls[0]).toMatch(/^blob:/);disposeGltf(gltf);
  });
  it("rejects swallowed extension texture errors instead of accepting an untextured model", async () => {
    stubBrowserAndFetch();vi.spyOn(console,'error').mockImplementation(()=>{});
    await expect(loadLocalGltf('/assets/models/cube-ktx2.gltf',new AbortController().signal,{setupDecoders:loader=>{
      loader.setKTX2Loader({load:(_url:string,_onLoad:unknown,_progress:unknown,onError:(error:Error)=>void)=>onError(new Error('invalid compressed texture'))} as never);
    }})).rejects.toThrow(/texture failed to decode/);
  });
  it.each(["cube.gltf", "cube.glb"])("loads %s through validated local dependency prefetch", async (file) => {
    const localFetch = stubBrowserAndFetch();
    const gltf = await loadLocalGltf(`/assets/models/${file}`, new AbortController().signal);
    expect(gltf.scene.getObjectByName("AuthoredCube")).toBeInstanceOf(THREE.Mesh);
    const mesh = gltf.scene.getObjectByName("AuthoredCube") as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
    expect(mesh.material.map).toBeInstanceOf(THREE.Texture);
    const localUrls = localFetch.mock.calls.map(([url]) => String(url)).filter((url) => url.startsWith("http:"));
    expect(localUrls).toHaveLength(file === "cube.gltf" ? 3 : 1);
    expect(localUrls.every((url) => url.startsWith("http://localhost:3000/assets/models/"))).toBe(true);
    disposeGltf(gltf);
  });
  it("loads plain models without invoking decoder setup", async () => {
    stubBrowserAndFetch();
    const setup = vi.fn();
    const gltf = await loadLocalGltf("/assets/models/cube.gltf", new AbortController().signal, { setupDecoders: setup });
    expect(gltf.scene.getObjectByName("AuthoredCube")).toBeInstanceOf(THREE.Mesh);
    expect(setup).not.toHaveBeenCalled();
    disposeGltf(gltf);
  });
  it("refuses decoder models before parsing when no setup is wired", async () => {
    const localFetch = stubBrowserAndFetch((url) =>
      url.endsWith("compressed.gltf") ? new Response(JSON.stringify(dracoDocument)) : undefined);
    await expect(loadLocalGltf("/assets/models/compressed.gltf", new AbortController().signal))
      .rejects.toThrow(/requires DRACO decoding but no decoder setup/);
    expect(localFetch).toHaveBeenCalledTimes(1);
  });
  it("awaits injected setup with the loader and detected needs, propagating its failure", async () => {
    stubBrowserAndFetch((url) =>
      url.endsWith("compressed.gltf") ? new Response(JSON.stringify(dracoDocument)) : undefined);
    const setup = vi.fn(async (_loader: GLTFLoader, needs: DecoderNeeds) => {
      expect(needs).toEqual({ draco: true });
      throw new Error("decoder files missing");
    });
    await expect(loadLocalGltf("/assets/models/compressed.gltf", new AbortController().signal, { setupDecoders: setup }))
      .rejects.toThrow(/decoder files missing/);
    expect(setup).toHaveBeenCalledTimes(1);
    expect(setup.mock.calls[0]![0]).toBeInstanceOf(GLTFLoader);
  });
  it("wraps decode failures of decoder models with an install hint", async () => {
    stubBrowserAndFetch((url) =>
      url.endsWith("compressed.gltf") ? new Response(JSON.stringify(dracoDocument)) : undefined);
    const setup = vi.fn(async () => undefined);
    await expect(loadLocalGltf("/assets/models/compressed.gltf", new AbortController().signal, { setupDecoders: setup }))
      .rejects.toThrow(/decode failed \(requires DRACO\).*public\/decoders\//s);
  });
  it("propagates aborts and missing dependency failures", async () => {
    vi.stubGlobal("window", { location: { href: "http://localhost:3000/", origin: "http://localhost:3000" } });
    const controller = new AbortController(); controller.abort();
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      init?.signal?.throwIfAborted();
      return new Response(JSON.stringify({ asset: { version: "2.0" }, buffers: [{ uri: "missing.bin" }] }));
    });
    vi.stubGlobal("fetch", fetch);
    await expect(loadLocalGltf("/assets/m.gltf", controller.signal)).rejects.toThrow();
    fetch.mockImplementation(async (url) => String(url).endsWith("missing.bin") ? new Response("", { status: 404 }) :
      new Response(JSON.stringify({ asset: { version: "2.0" }, buffers: [{ uri: "missing.bin" }] })));
    await expect(loadLocalGltf("/assets/m.gltf", new AbortController().signal)).rejects.toThrow(/404/);
  });
  it("rejects cross-origin models before fetch", async () => {
    vi.stubGlobal("window", { location: { href: "http://localhost:3000/", origin: "http://localhost:3000" } });
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(loadLocalGltf("https://remote/model.glb", new AbortController().signal)).rejects.toThrow(/same-origin/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects missing model and unsafe textures before dependency requests", async () => {
    vi.stubGlobal("window", { location: { href: "http://localhost:3000/", origin: "http://localhost:3000" } });
    const fetch = vi.fn(async () => new Response("missing", { status: 404 })); vi.stubGlobal("fetch", fetch);
    await expect(loadLocalGltf("/assets/m.glb", new AbortController().signal)).rejects.toThrow(/404/);
    fetch.mockImplementation(async () => new Response(JSON.stringify({ asset: { version: "2.0" }, images: [{ uri: "../escape.png" }] })));
    await expect(loadLocalGltf("/assets/m.gltf", new AbortController().signal)).rejects.toThrow(/Unsafe/);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
