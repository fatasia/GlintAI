import { z } from "zod";

/** Portable paths: no URL decoding, platform aliases, or traversal at any layer. */
export function isSafeRelativeAssetPath(value: string): boolean {
  return value.length > 0 && !/[\\:%?#\u0000-\u001f\u007f]/.test(value) &&
    value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".." &&
      !/[. ]$/.test(part) && !/[<>"|*]/.test(part) &&
      !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}

export const LocalAssetPath = z.string().refine(
  (value) => value.startsWith("assets/") && isSafeRelativeAssetPath(value),
  "must be a local assets/ path without URLs, absolute paths, or traversal",
);
export const GltfAssetPath = LocalAssetPath.refine(
  (value) => /\.(gltf|glb)$/i.test(value), "model src must end in .gltf or .glb",
);

const embeddedResource = /^data:(?:application\/(?:octet-stream|gltf-buffer)|image\/(?:png|jpeg|webp));base64,[A-Za-z0-9+/]*={0,2}$/;
// Draco/KTX2 decode through the self-hosted decoders wired in
// packages/video/src/scenes/gltf.ts (files copied from the three package by
// apps/studio/scripts/decoders.ts); meshopt has no hosted decoder and stays rejected.
const unsupportedExtensions = new Set([
  "EXT_meshopt_compression",
]);

/** Reads the JSON chunk only; GPU/buffer decoding remains GLTFLoader's job. */
export function readGltfDocument(bytes: Uint8Array): Record<string, unknown> {
  let jsonBytes = bytes;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 4 && view.getUint32(0, true) === 0x46546c67) {
    if (bytes.length < 20 || view.getUint32(4, true) !== 2 ||
        view.getUint32(8, true) !== bytes.length) throw new Error("Invalid GLB v2 header or length");
    let offset = 12;
    while (offset < bytes.length) {
      if (offset + 8 > bytes.length) throw new Error("Truncated GLB chunk");
      const length = view.getUint32(offset, true);
      if (length % 4 || offset + 8 + length > bytes.length) throw new Error("Invalid GLB chunk length");
      if (offset === 12) {
        if (view.getUint32(offset + 4, true) !== 0x4e4f534a) throw new Error("GLB must start with JSON");
        jsonBytes = bytes.subarray(offset + 8, offset + 8 + length);
      }
      offset += 8 + length;
    }
  }
  const document: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(jsonBytes));
  if (!document || typeof document !== "object" || Array.isArray(document) ||
      (document as { asset?: { version?: string } }).asset?.version !== "2.0") {
    throw new Error("Expected a glTF 2.0 document");
  }
  return document as Record<string, unknown>;
}

/** Validate before GLTFLoader sees a byte; includes URIs nested in extensions. */
export function gltfExternalResources(document: Record<string, unknown>): string[] {
  const resources = new Set<string>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 100) throw new Error("glTF document nesting exceeds 100 levels");
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "extensions" && child && typeof child === "object") {
        for (const name of Object.keys(child)) {
          if (unsupportedExtensions.has(name)) throw new Error(`Unsupported glTF decoder extension: ${name}`);
        }
      }
      if ((key === "extensionsUsed" || key === "extensionsRequired") && Array.isArray(child)) {
        for (const name of child) {
          if (unsupportedExtensions.has(name)) throw new Error(`Unsupported glTF decoder extension: ${name}`);
        }
      }
      if (key === "uri") {
        if (typeof child !== "string") throw new Error("glTF resource URI must be a string");
        if (!embeddedResource.test(child)) {
          if (!isSafeRelativeAssetPath(child)) throw new Error(`Unsafe glTF resource URI: ${child}`);
          resources.add(child);
        }
      } else visit(child, depth + 1);
    }
  };
  visit(document, 0);
  return [...resources];
}
