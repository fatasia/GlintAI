import * as THREE from "three";
import { gltfExternalResources, readGltfDocument } from "@glintai/scenescript";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

/** Decoder paths under the served public dir, populated by apps/studio/scripts/decoders.ts. */
export const DRACO_DECODER_PATH = "decoders/draco/";
export const KTX2_TRANSCODER_PATH = "decoders/basis/";

const DRACO_EXTENSION = "KHR_draco_mesh_compression";
const KTX2_EXTENSION = "KHR_texture_basisu";

/** Compressed-geometry/texture extensions a glTF document actually needs. */
export interface DecoderNeeds {
  draco?: true;
  ktx2?: true;
}

/**
 * Detects DRACO/KTX2 from extensionsUsed/extensionsRequired and, for sloppy
 * exporters, from any nested extensions object (depth-bounded like the
 * document guard in @glintai/scenescript).
 */
export function detectDecoderNeeds(document: Record<string, unknown>): DecoderNeeds {
  const needs: DecoderNeeds = {};
  const mark = (name: unknown): void => {
    if (name === DRACO_EXTENSION) needs.draco = true;
    else if (name === KTX2_EXTENSION) needs.ktx2 = true;
  };
  const visit = (value: unknown, depth: number): void => {
    if (depth > 100) throw new Error("glTF document nesting exceeds 100 levels");
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if ((key === "extensionsUsed" || key === "extensionsRequired") && Array.isArray(child)) {
        for (const name of child) mark(name);
      } else if (key === "extensions" && child && typeof child === "object" && !Array.isArray(child)) {
        for (const name of Object.keys(child)) mark(name);
        visit(child, depth + 1);
      } else visit(child, depth + 1);
    }
  };
  visit(document, 0);
  return needs;
}

function decoderNames(needs: DecoderNeeds): string[] {
  return [needs.draco ? "DRACO" : null, needs.ktx2 ? "KTX2" : null]
    .filter((name): name is string => name !== null);
}

/** Structural views so tests can inject stubs for three's DRACOLoader/KTX2Loader. */
export interface DecoderAttachableLoader {
  setDRACOLoader(decoder: unknown): unknown;
  setKTX2Loader(transcoder: unknown): unknown;
}
export interface DracoDecoderLike {
  setDecoderPath(path: string): unknown;
}
export interface Ktx2TranscoderLike {
  setTranscoderPath(path: string): unknown;
  detectSupport(renderer: THREE.WebGLRenderer): unknown;
}
export interface DecoderFactories {
  draco?: () => DracoDecoderLike | Promise<DracoDecoderLike>;
  ktx2?: () => Ktx2TranscoderLike | Promise<Ktx2TranscoderLike>;
}

// Decoder modules load lazily so bundles and models without compressed
// geometry never pay for them. They spawn worker pools when instantiated,
// so instances are cached per factory identity and reused across loads.
const defaultDecoderFactories: DecoderFactories = {
  draco: async () => {
    const { DRACOLoader } = await import("three/examples/jsm/loaders/DRACOLoader.js");
    return new DRACOLoader();
  },
  ktx2: async () => {
    const { KTX2Loader } = await import("three/examples/jsm/loaders/KTX2Loader.js");
    return new KTX2Loader();
  },
};

const decoderPool = new Map<DecoderFactories, {
  draco?: DracoDecoderLike;
  ktx2?: Ktx2TranscoderLike;
  ktx2Renderer?: THREE.WebGLRenderer;
}>();

/** Drops cached decoder instances (test isolation only). */
export function resetGltfDecoderPool(): void {
  decoderPool.clear();
}

/** Wires only the decoders the model needs; no-op for plain models. */
export async function attachGltfDecoders(
  loader: DecoderAttachableLoader,
  needs: DecoderNeeds,
  renderer: THREE.WebGLRenderer | null,
  factories: DecoderFactories = defaultDecoderFactories,
  publicPath: (file: string) => string = (file) => file,
): Promise<void> {
  let pool = decoderPool.get(factories);
  if (!pool) {
    pool = {};
    decoderPool.set(factories, pool);
  }
  if (needs.draco) {
    if (!factories.draco) throw new Error("No DRACO decoder factory is available");
    const draco = pool.draco ?? await factories.draco();
    pool.draco = draco;
    draco.setDecoderPath(publicPath(DRACO_DECODER_PATH));
    loader.setDRACOLoader(draco);
  }
  if (needs.ktx2) {
    if (!renderer) throw new Error("KTX2 textures need a WebGL renderer (R3F state.gl) for detectSupport");
    if (!factories.ktx2) throw new Error("No KTX2 transcoder factory is available");
    const ktx2 = pool.ktx2 ?? await factories.ktx2();
    pool.ktx2 = ktx2;
    ktx2.setTranscoderPath(publicPath(KTX2_TRANSCODER_PATH));
    if (pool.ktx2Renderer !== renderer) {
      ktx2.detectSupport(renderer);
      pool.ktx2Renderer = renderer;
    }
    loader.setKTX2Loader(ktx2);
  }
}

async function fetchAsset(url: string, signal: AbortSignal): Promise<Uint8Array> {
  const response = await fetch(url, { signal, redirect: "error" });
  if (!response.ok) throw new Error(`Asset request failed (${response.status}): ${url}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`Asset response has no body: ${url}`);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_FILE_BYTES) throw new Error(`Asset exceeds 64 MiB: ${url}`);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

export interface GltfLoadOptions {
  /**
   * Wires DRACO/KTX2 decoders onto the loader before parsing; invoked only
   * when the document requires them (see attachGltfDecoders). Must complete
   * within the caller's delayRender window.
   */
  setupDecoders?: (loader: GLTFLoader, needs: DecoderNeeds) => Promise<void> | void;
}

/** Prefetch validated local dependencies; GLTFLoader never resolves arbitrary URLs. */
export async function loadLocalGltf(
  url: string,
  signal: AbortSignal,
  options: GltfLoadOptions = {},
): Promise<GLTF> {
  const base = new URL(url, window.location.href);
  if (base.origin !== window.location.origin) throw new Error("Model must use same-origin local assets");
  const bytes = await fetchAsset(base.href, signal);
  const document = readGltfDocument(bytes);
  const refs = gltfExternalResources(document);
  if (refs.length > 2048) throw new Error("Too many glTF dependencies");
  const blobs = new Map<string, string>();
  let totalBytes = bytes.length;
  const manager = new THREE.LoadingManager();
  let resourceError: string | undefined;
  manager.onError = (resource) => { resourceError = resource; };
  manager.setURLModifier((resource) => {
    const mapped = blobs.get(resource);
    if (mapped) return mapped;
    // Document URIs were validated above; blob URIs here are created for GLB images.
    if (resource.startsWith("data:") || resource.startsWith(`blob:${base.origin}/`)) return resource;
    resourceError = resource;
    throw new Error(`Unapproved glTF resource: ${resource}`);
  });
  const abort = () => manager.abort();
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (const ref of refs) {
      signal.throwIfAborted();
      const resource = await fetchAsset(new URL(ref, base).href, signal);
      totalBytes += resource.length;
      if (totalBytes > MAX_TOTAL_BYTES) throw new Error("glTF dependencies exceed 256 MiB");
      // ImageBitmapLoader decodes by signature, not filename/MIME.
      blobs.set(ref, URL.createObjectURL(new Blob([resource as Uint8Array<ArrayBuffer>])));
    }
    signal.throwIfAborted();
    const loader = new GLTFLoader(manager);
      // Extension loaders (notably KTX2Loader) own another LoadingManager.
      // Rewrite validated URIs before parsing so they also consume our prefetched blobs.
      loader.register((parser) => {
        const rewrite = (value: unknown): void => {
          if (!value || typeof value !== "object") return;
          for (const [key, child] of Object.entries(value)) {
            if (key === "uri" && typeof child === "string" && blobs.has(child)) (value as Record<string, unknown>)[key] = blobs.get(child)!;
            else rewrite(child);
          }
        };
        rewrite(parser.json);
        return { name: "GLINT_preloaded_resources", afterRoot: async () => {
          const textures = await parser.getDependencies("texture");
          if (textures.some((texture: unknown) => !texture)) throw new Error("glTF texture failed to decode");
        } };
      });
    const needs = detectDecoderNeeds(document);
    if (needs.draco || needs.ktx2) {
      const which = decoderNames(needs).join(" + ");
      if (!options.setupDecoders) {
        throw new Error(
          `Model requires ${which} decoding but no decoder setup was provided ` +
          `(self-hosted decoders live in public/decoders/ — run "pnpm --filter glint-studio decoders")`,
        );
      }
      await options.setupDecoders(loader, needs);
    }
    signal.throwIfAborted();
    let gltf: GLTF;
    try {
      gltf = await loader.parseAsync(bytes.buffer as ArrayBuffer, "");
    } catch (error) {
      if (needs.draco || needs.ktx2) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(
          `glTF decode failed (requires ${decoderNames(needs).join(" + ")}): ${reason}. ` +
          `If decoders are missing, run "pnpm --filter glint-studio decoders" to copy them into public/decoders/.`,
        );
      }
      throw error;
    }
    if (signal.aborted || resourceError) {
      disposeGltf(gltf);
      signal.throwIfAborted();
      throw new Error(`glTF texture or buffer failed to load: ${resourceError}`);
    }
    return gltf;
  } finally {
    signal.removeEventListener("abort", abort);
    for (const blob of blobs.values()) URL.revokeObjectURL(blob);
  }
}

/** Normalize in a parent group so animations keep their authored local transforms. */
export function fitGltf(object: THREE.Object3D): {
  scale: number; position: THREE.Vector3;
} {
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const largest = Math.max(size.x, size.y, size.z);
  if (!Number.isFinite(largest) || largest <= 0) throw new Error("glTF model has no finite visible bounds");
  const scale = 2.8 / largest;
  return { scale, position: box.getCenter(new THREE.Vector3()).multiplyScalar(-scale) };
}

export function fittedCameraDistance(aspect: number, fov = 40): number {
  const halfFov = THREE.MathUtils.degToRad(fov / 2);
  const limitingHalfFov = Math.min(halfFov, Math.atan(Math.tan(halfFov) * aspect));
  // Bounding sphere covers every orientation, including all three aspect ratios.
  return (Math.sqrt(3) * 1.4) / Math.sin(limitingHalfFov) * 1.12;
}

export function createGltfMixer(gltf: Pick<GLTF, "scene" | "animations">): THREE.AnimationMixer {
  const mixer = new THREE.AnimationMixer(gltf.scene);
  for (const clip of gltf.animations) mixer.clipAction(clip).play();
  return mixer;
}

export function seekGltfAnimation(mixer: THREE.AnimationMixer, frame: number, fps: number): void {
  mixer.setTime(frame / fps);
}

export function disposeGltf(gltf: Pick<GLTF, "scenes">): void {
  const disposed = new Set<object>();
  const once = (object: { dispose(): void }) => {
    if (!disposed.has(object)) { disposed.add(object); object.dispose(); }
  };
  const disposeTexture = (texture: THREE.Texture) => {
    if (disposed.has(texture)) return;
    once(texture);
    const images: unknown[] = Array.isArray(texture.source?.data) ? texture.source.data : [texture.source?.data];
    for (const image of images) {
      if (typeof ImageBitmap !== "undefined" && image instanceof ImageBitmap && !disposed.has(image)) {
        disposed.add(image); image.close();
      }
    }
  };
  for (const scene of gltf.scenes) scene.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (mesh.geometry) once(mesh.geometry);
    const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const material of materials) {
      if (disposed.has(material)) continue;
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) disposeTexture(value);
      }
      once(material);
    }
    if ((node as THREE.SkinnedMesh).skeleton?.boneTexture) disposeTexture((node as THREE.SkinnedMesh).skeleton.boneTexture!);
  });
}
