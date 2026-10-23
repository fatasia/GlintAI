import { parseProject, type SceneScriptProject } from "@glintai/scenescript";
import type { CreationPackInstance } from "./creation-packs";

/** Attribution is supplied by the author, not a license or safety certification. */
export interface ImportedCreationPack {
  format: "glint-creation-pack";
  version: 1;
  id: string;
  packVersion: string;
  title: string;
  description: string;
  author: string;
  license: string;
  tags: string[];
  permissions: [];
  project: SceneScriptProject;
}

export const IMPORTED_PACK_MAX_BYTES = 128 * 1024;
const MAX_TEXT = 4096;
const MAX_ID = 120;
const MAX_SCENES = 20;
const RESERVED = new Set(["__proto__", "prototype", "constructor", "toJSON"]);
const ROOT_KEYS = new Set(["format", "version", "id", "packVersion", "title", "description", "author", "license", "tags", "permissions", "project"]);
const SCENE_KINDS = new Set(["title", "bullets", "comparison", "chart", "definition", "quote", "diagram", "code"]);
const FORBIDDEN_PROJECT = ["assets", "music", "sfx"];
const FORBIDDEN_SCENE = ["assetRefs", "src", "html", "animation", "provenance", "audioRef"];
type RecordValue = Record<string, unknown>;

function invalid(message: string): never {
  throw new Error(`Invalid imported creation pack: ${message}`);
}

/** Inspect descriptors BEFORE cloning/stringifying so accessors are never read. */
function assertJson(value: unknown): void {
  const ancestors = new Set<object>();
  let nodes = 0;
  let textLength = 0;
  function visit(item: unknown, depth: number): void {
    if (++nodes > 20_000 || depth > 40) invalid("JSON structure is too large or deeply nested.");
    if (typeof item === "string") {
      textLength += item.length;
      if (item.length > MAX_TEXT || textLength > IMPORTED_PACK_MAX_BYTES) invalid(`text exceeds the ${MAX_TEXT}-character or total size limit.`);
      return;
    }
    if (item === null || typeof item === "boolean") return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (typeof item !== "object" || !item) invalid("only finite JSON data is supported.");
    const array = Array.isArray(item);
    const prototype = Object.getPrototypeOf(item);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) invalid("custom prototypes are not allowed.");
    if (ancestors.has(item)) invalid("cyclic JSON is not supported.");
    ancestors.add(item);
    if (array && item.length > 20_000) invalid("array is too large.");
    const keys = Reflect.ownKeys(item);
    if (array && keys.length !== item.length + 1) invalid("arrays must not contain holes or extra properties.");
    for (const key of keys) {
      if (array && key === "length") continue;
      if (typeof key !== "string" || RESERVED.has(key) || key.length > MAX_ID) invalid("reserved, symbolic or oversized JSON key.");
      if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= item.length)) invalid("invalid array property.");
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid("accessors and hidden properties are not allowed.");
      visit(descriptor.value, depth + 1);
    }
    ancestors.delete(item);
  }
  visit(value, 0);
}

function record(value: unknown, label: string): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object.`);
  return value as RecordValue;
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) invalid(`${label} must be nonempty text of at most ${max} characters.`);
  return value;
}

function id(value: unknown, label: string): string {
  const result = text(value, label, MAX_ID);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(result) || RESERVED.has(result)) invalid(`${label} must be a kebab-case ID.`);
  return result;
}

/** Existing SceneScript validators strip unknown keys; imports must reject them. */
function assertNoDiscardedFields(input: unknown, parsed: unknown, path = "project"): void {
  if (!input || typeof input !== "object") return;
  if (!parsed || typeof parsed !== "object") invalid(`${path} contains unsupported data.`);
  for (const key of Object.keys(input)) {
    if (!Object.prototype.hasOwnProperty.call(parsed, key)) invalid(`unsupported field ${path}.${key}.`);
    assertNoDiscardedFields((input as RecordValue)[key], (parsed as RecordValue)[key], `${path}.${key}`);
  }
}

function validateProject(value: unknown): SceneScriptProject {
  const source = record(value, "project");
  for (const key of FORBIDDEN_PROJECT) if (key in source) invalid(`${key} is not supported in data-only packs.`);
  if (!Array.isArray(source.knowledgeSources) || source.knowledgeSources.length) invalid("knowledgeSources must be an empty array.");
  if (!Array.isArray(source.scenes) || !source.scenes.length || source.scenes.length > MAX_SCENES) invalid(`project must contain 1–${MAX_SCENES} scenes.`);
  id(source.id, "project.id");
  if (source.theme !== undefined && (typeof source.theme !== "string" || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(source.theme))) invalid("theme must be a static theme name, not inline tokens or a URL.");
  for (const item of source.scenes) {
    const scene = record(item, "scene");
    if (typeof scene.kind !== "string" || !SCENE_KINDS.has(scene.kind)) invalid("only static structured scenes are allowed (no HTML, three, image or video).");
    id(scene.id, "scene.id");
    for (const key of FORBIDDEN_SCENE) if (key in scene) invalid(`scene.${key} is not supported.`);
    const narration = record(scene.narration, "narration");
    if ("audioRef" in narration) invalid("narration.audioRef is not supported.");
    text(narration.text, "narration.text", MAX_TEXT);
  }
  const project = parseProject(source);
  assertNoDiscardedFields(source, project);
  // Notes are private editing context, never part of an installed portable recipe.
  for (const scene of project.scenes) delete scene.notes;
  function boundIds(item: unknown): void {
    if (!item || typeof item !== "object") return;
    for (const [key, value] of Object.entries(item)) {
      if (key === "id" || key === "elementId" || key === "key") id(value, key);
      boundIds(value);
    }
  }
  boundIds(project);
  return project;
}

/** Pure JSON-value parser: no URL fetching, asset resolution, templates or execution. */
export function parseImportedPack(value: unknown): ImportedCreationPack {
  assertJson(value);
  const detached: unknown = structuredClone(value);
  if (new TextEncoder().encode(JSON.stringify(detached)).byteLength > IMPORTED_PACK_MAX_BYTES) invalid("JSON exceeds 128 KiB.");
  const source = record(detached, "pack");
  for (const key of Object.keys(source)) if (!ROOT_KEYS.has(key)) invalid(`unsupported root field ${key}.`);
  if (source.format !== "glint-creation-pack" || source.version !== 1) invalid("expected format glint-creation-pack and version 1.");
  const packId = id(source.id, "id");
  const packVersion = text(source.packVersion, "packVersion", 40);
  // The project origin pin currently supports stable SemVer only.
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(packVersion)) invalid("packVersion must be stable SemVer (major.minor.patch, no leading zeros).");
  if (source.permissions !== undefined && (!Array.isArray(source.permissions) || source.permissions.length)) invalid("permissions must be empty; capabilities are not supported.");
  if (!Array.isArray(source.tags) || source.tags.length > 20) invalid("tags must be an array of at most 20 strings.");
  const tags = source.tags.map(tag => text(tag, "tag", 60));
  if (new Set(tags).size !== tags.length) invalid("duplicate tags are not allowed.");
  return {
    format: "glint-creation-pack", version: 1, id: packId, packVersion,
    title: text(source.title, "title", 120), description: text(source.description, "description", 1000),
    author: text(source.author, "author", 120), license: text(source.license, "license", 120),
    tags, permissions: [], project: validateProject(source.project),
  };
}

/** Revalidate at use time; callers may have edited an installed pack since parsing. */
export function materializeImportedPack(pack: ImportedCreationPack, options: { projectId?: string } = {}): CreationPackInstance {
  const validated = parseImportedPack(pack);
  assertJson(options);
  const settings = record(options, "options");
  if (Object.keys(settings).some(key => key !== "projectId")) invalid("unsupported materialization option.");
  let projectId = settings.projectId;
  if (projectId === undefined) {
    if (typeof globalThis.crypto?.randomUUID !== "function") invalid("provide projectId or use a browser with crypto.randomUUID.");
    projectId = `pack-${globalThis.crypto.randomUUID()}`;
  }
  const receipt = { id: validated.id, version: validated.packVersion };
  const project = parseProject({ ...validated.project, id: id(projectId, "projectId"), creationPack: receipt });
  return { project, pack: { ...receipt }, inputs: {} };
}
