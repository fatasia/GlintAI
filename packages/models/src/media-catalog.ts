import { createRegistry } from "./registry";
import type { ModelEntry } from "./schema";

export type MediaCapability = "reference-image" | "image-to-image" | "transparent-background";
export type MediaKind = "image" | "video" | "audio";
export interface MediaCatalogModel {
  id: string; name?: string; tags?: unknown; registry: ModelEntry;
  [key: string]: unknown;
}
const referenceTags = new Set(["图片编辑", "图生图", "多图参考", "参考", "Image editing", "Image-to-image", "Multi-image reference", "Reference"]);
const imageTags = new Set(["图生图", "Image-to-image"]);
const transparentTags = new Set(["透明背景", "Transparent background"]);

/** Only exact explicit gateway tags grant capability; model names never do. */
function capabilities(tags: unknown, kind: MediaKind, protocol: string): MediaCapability[] {
  if (protocol !== "skills" || kind !== "image" || !Array.isArray(tags) || tags.length > 32 || tags.some(tag => typeof tag !== "string" || tag.length > 120)) return [];
  const result: MediaCapability[] = [];
  if (tags.some(tag => referenceTags.has(tag))) result.push("reference-image");
  if (tags.some(tag => imageTags.has(tag))) result.push("image-to-image");
  if (tags.some(tag => transparentTags.has(tag))) result.push("transparent-background");
  return result;
}

/** Ephemeral catalog, not a persistent registry or execution/price discovery service. */
export function projectMediaCatalog(input: unknown, kind: MediaKind, protocol: string): MediaCatalogModel[] {
  if (!Array.isArray(input) || input.length > 500 || !["skills", "openai-images"].includes(protocol) || !["image", "video", "audio"].includes(kind) || (protocol === "openai-images" && kind !== "image")) return [];
  const seen = new Set<string>();
  const models = input.filter((model): model is Record<string, unknown> & { id: string } => {
    if (!model || typeof model !== "object" || Array.isArray(model) || typeof model.id !== "string" || !model.id.trim() || model.id.length > 160 || /[\u0000-\u001f\u007f]/.test(model.id) || model.available_for_this_key === false || seen.has(model.id)) return false;
    seen.add(model.id); return true;
  });
  const registry = createRegistry(models.map((model, index) => ({
    id: `catalog-${index}`, name: typeof model.name === "string" && model.name.trim() ? model.name.slice(0, 120) : model.id.slice(0, 120),
    provider: "configured-media", kind, capabilities: model.capabilityTagsValid === false ? [] : capabilities(model.tags, kind, protocol),
    pricing: { basis: "unknown" }, limits: {}, source: "user",
    adapter: { type: protocol === "skills" ? "skills-gateway" : "openai-images", model: model.id },
  })));
  return models.map((model, index) => ({ ...model, registry: registry.entries[index]! }));
}

/** Reproject raw declarations even when metadata exists: stale/forged capabilities never widen access. */
export function supportsMediaCapability(model: unknown, protocol: string, capability: MediaCapability): boolean {
  return projectMediaCatalog([model], "image", protocol)[0]?.registry.capabilities.includes(capability) ?? false;
}
