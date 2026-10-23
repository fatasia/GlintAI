import { parseNleProject, type NleClip, type NleProject, type NleTrack } from "@glintai/scenescript";

/**
 * JianYing (剪映专业版) draft import → Glint NLE project.
 *
 * Companion to `jianying.ts` (export). The draft_content.json layout follows
 * the publicly documented draft schema: microsecond timebase, materials/
 * tracks/segments, clip.alpha/scale/rotation/transform, text content as an
 * embedded JSON string. Import is a structural mapping, deliberately honest:
 * filters, stickers, effects, transitions and keyframes are counted and
 * reported — never silently dropped — and media paths are mapped to the Glint
 * media library by sanitized basename.
 */

const US = 1_000_000;

export interface JianyingMapping { original: string; library: string; kind: "video" | "image" | "audio"; found: boolean }

export interface JianyingImport {
  project: NleProject;
  mapping: JianyingMapping[];
  /** Counted, not imported: filter/sticker/effect/transition/keyframe usage. */
  skipped: Record<string, number>;
  warnings: string[];
}

interface DraftSegment {
  id?: unknown;
  material_id?: unknown;
  target_timerange?: { start?: unknown; duration?: unknown } | null;
  source_timerange?: { start?: unknown; duration?: unknown } | null;
  clip?: { alpha?: unknown; scale?: unknown; rotation?: unknown; speed?: unknown } | null;
  extra_material_refs?: unknown;
}

interface DraftTrack {
  id?: unknown;
  type?: unknown;
  name?: unknown;
  segments?: DraftSegment[];
}

interface DraftTextStyles { size?: unknown; range?: unknown; fill?: { content?: { solid?: { color?: unknown } } } }

/**
 * Drafts from JianYing 6.x are encrypted at rest ("草稿加密" is on by default);
 * the file then starts with base64-looking noise instead of "{". Detection is
 * heuristic but conclusive in practice — real drafts are multi-hundred-KB JSON.
 */
export function looksEncrypted(text: string): boolean {
  const head = text.slice(0, 64).trim();
  return head.startsWith("{") === false && /^[A-Za-z0-9+/=]{40,}$/.test(head.replace(/\s/g, ""));
}

/** Media library names allow [a-zA-Z0-9_-] only; JianYing paths are arbitrary local paths. */
function libraryName(path: string, used: Map<string, string>): string | null {
  const base = path.split(/[\\/]/).pop() ?? "";
  const match = /^(.+)\.(png|jpe?g|webp|mp4|mp3|wav)$/i.exec(base);
  if (!match) return null;
  const stem = match[1]!.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "asset";
  const extension = match[2]!.toLowerCase().replace(/^jpeg$/, "jpg");
  const candidate = `${stem}.${extension}`;
  if (!used.has(candidate)) { used.set(candidate, base); return candidate; }
  for (let index = 2; ; index++) {
    const numbered = `${stem}-${index}.${extension}`;
    if (!used.has(numbered)) { used.set(numbered, base); return numbered; }
  }
}

function intAt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : undefined;
}

function msRange(range: { start?: unknown; duration?: unknown } | null | undefined): { start: number; duration: number } | null {
  const start = intAt(range?.start), duration = intAt(range?.duration);
  if (start === undefined || duration === undefined || duration <= 0) return null;
  return { start: Math.max(0, Math.round(start / 1000)), duration: Math.round(duration / 1000) };
}

function hexColor(rgb: unknown): string | undefined {
  if (!Array.isArray(rgb) || rgb.length < 3) return undefined;
  const parts = rgb.slice(0, 3).map(value => typeof value === "number" && Number.isFinite(value) ? Math.round(Math.min(1, Math.max(0, value)) * 255) : null);
  if (parts.some(part => part === null)) return undefined;
  return `#${parts.map(part => (part as number).toString(16).padStart(2, "0")).join("")}`;
}

function textFromContent(content: unknown): { text: string; fontSize?: number; color?: string } {
  if (typeof content !== "string") return { text: "" };
  try {
    const parsed = JSON.parse(content) as { text?: unknown; styles?: DraftTextStyles[] };
    const text = typeof parsed.text === "string" ? parsed.text : "";
    const style = Array.isArray(parsed.styles) ? parsed.styles[0] : undefined;
    // JianYing font size is a unitless ratio (~8 for a full-width title); map to px on a 1080-high canvas.
    const fontSize = typeof style?.size === "number" && Number.isFinite(style.size) && style.size > 0
      ? Math.min(240, Math.max(12, Math.round(style.size * 12))) : undefined;
    const color = hexColor(style?.fill?.content?.solid?.color);
    return { text, fontSize, color };
  } catch { return { text: content.slice(0, 500) }; }
}

function trackId(prefix: string, used: Set<string>): string {
  for (let index = 1; ; index++) {
    const candidate = `${prefix}${index}`;
    if (!used.has(candidate)) { used.add(candidate); return candidate; }
  }
}

/** Clip ids must be globally unique kebab-case; JianYing ids are uuids, so sanitize. */
function clipId(raw: unknown, fallback: string, used: Set<string>): string {
  const base = (typeof raw === "string" ? raw : "").replace(/[^a-zA-Z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 55) || fallback;
  if (!used.has(base)) { used.add(base); return base; }
  for (let index = 2; ; index++) {
    const numbered = `${base.slice(0, 53)}-${index}`;
    if (!used.has(numbered)) { used.add(numbered); return numbered; }
  }
}

/**
 * Convert a parsed draft_content.json. Throws (with a plain-language message)
 * only when the document is not a JianYing draft at all; structural oddities
 * come back as warnings plus whatever mapped cleanly.
 */
export function importJianyingDraft(draft: unknown, isAssetAvailable: (libraryName: string) => boolean = () => false): JianyingImport {
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) throw new Error("这不是剪映草稿文件（需要 draft_content.json 的 JSON）");
  const root = draft as {
    fps?: unknown; canvas_config?: { width?: unknown; height?: unknown }; duration?: unknown;
    materials?: { videos?: unknown[]; audios?: unknown[]; texts?: unknown[] } ;
    tracks?: unknown;
  };
  const tracksInput = Array.isArray(root.tracks) ? root.tracks : null;
  const materials = root.materials && typeof root.materials === "object" ? root.materials : null;
  if (!tracksInput || !materials) throw new Error("这不是剪映草稿文件（缺少 tracks/materials 结构）");

  const width = Math.min(7680, Math.max(16, intAt(root.canvas_config?.width) ?? 1920));
  const height = Math.min(4320, Math.max(16, intAt(root.canvas_config?.height) ?? 1080));
  const fps = typeof root.fps === "number" && root.fps >= 1 && root.fps <= 120 ? Math.round(root.fps) : 30;

  const usedNames = new Map<string, string>();
  const mediaMaterials = new Map<string, { library: string; kind: "video" | "image" | "audio" }>();
  for (const material of materials.videos ?? []) {
    const entry = material as { id?: unknown; type?: unknown; path?: unknown };
    if (typeof entry.id !== "string" || typeof entry.path !== "string") continue;
    const library = libraryName(entry.path, usedNames);
    if (!library) continue;
    mediaMaterials.set(entry.id, { library, kind: /\.(mp4)$/i.test(library) ? "video" : "image" });
  }
  for (const material of materials.audios ?? []) {
    const entry = material as { id?: unknown; path?: unknown };
    if (typeof entry.id !== "string" || typeof entry.path !== "string") continue;
    const library = libraryName(entry.path, usedNames);
    if (!library) continue;
    mediaMaterials.set(entry.id, { library, kind: "audio" });
  }
  const textMaterials = new Map<string, string>();
  for (const material of materials.texts ?? []) {
    const entry = material as { id?: unknown; content?: unknown };
    if (typeof entry.id !== "string") continue;
    textMaterials.set(entry.id, textFromContent(entry.content).text);
  }

  const mapping = new Map<string, JianyingMapping>();
  for (const material of [...(materials.videos ?? []), ...(materials.audios ?? [])]) {
    const entry = material as { id?: unknown; path?: unknown };
    const target = typeof entry.id === "string" ? mediaMaterials.get(entry.id) : undefined;
    if (!target || typeof entry.path !== "string") continue;
    mapping.set(target.library, { original: entry.path.split(/[\\/]/).pop() ?? entry.path, library: target.library, kind: target.kind, found: isAssetAvailable(target.library) });
  }

  const usedTrackIds = new Set<string>(), usedClipIds = new Set<string>();
  const skipped: Record<string, number> = {};
  const warnings: string[] = [];
  const note = (key: string) => { skipped[key] = (skipped[key] ?? 0) + 1; };
  // JianYing paints later tracks above earlier ones; the first visual track is
  // the main track. Kinds are assigned after the walk so the mapping does not
  // depend on where the text track happens to sit in the draft.
  const visualTracks: NleTrack[] = [], audioTracks: NleTrack[] = [];
  let textTrack: NleTrack | null = null;
  let textSeen = 0;
  for (const rawTrack of tracksInput) {
    const track = rawTrack as DraftTrack;
    const kind = typeof track.type === "string" ? track.type : "";
    if (!Array.isArray(track.segments) || !track.segments.length) continue;
    if (kind !== "video" && kind !== "audio" && kind !== "text" && kind !== "sticker" && kind !== "effect") continue;
    const clips: NleClip[] = [];
    for (const segment of track.segments) {
      if (typeof segment.material_id !== "string") continue;
      const target = msRange(segment.target_timerange);
      if (!target) { note("无时间区间"); continue; }
      const clipAlpha = typeof segment.clip?.alpha === "number" ? Math.min(1, Math.max(0, segment.clip.alpha)) : 1;
      const scale = typeof segment.clip?.scale === "number" && segment.clip.scale > 0 ? Math.min(8, Math.max(0.05, segment.clip.scale)) : 1;
      const rotation = typeof segment.clip?.rotation === "number" ? Math.min(180, Math.max(-180, Math.round(segment.clip.rotation))) : 0;
      const speed = typeof segment.clip?.speed === "number" && segment.clip.speed >= 0.25 && segment.clip.speed <= 4 ? segment.clip.speed : 1;
      if (segment.clip?.speed !== undefined && speed === 1 && typeof segment.clip.speed === "number" && segment.clip.speed !== 1) note("速度超出 0.25–4，按 1× 导入");
      if (Array.isArray(segment.extra_material_refs) && segment.extra_material_refs.length) note("引用效果/转场素材");
      const id = clipId(segment.id, `clip-${clips.length + 1}`, usedClipIds);
      if (kind === "text") {
        textSeen++;
        const text = textMaterials.get(segment.material_id) ?? "";
        if (!text.trim()) { note("空文字"); continue; }
        const foundText = (materials.texts ?? []).find(material => (material as { id?: unknown }).id === segment.material_id) as { content?: unknown } | undefined;
        const style = textFromContent(foundText?.content);
        clips.push({ id, kind: "text", text: text.slice(0, 500), startMs: target.start, durationMs: target.duration, ...(style.fontSize ? { fontSize: style.fontSize } : {}), ...(style.color ? { color: style.color } : {}), align: "center", ...(clipAlpha < 1 ? { opacity: clipAlpha } : {}) });
        continue;
      }
      const material = mediaMaterials.get(segment.material_id);
      if (!material) { note(`未映射的 ${kind} 素材`); continue; }
      if (material.kind === "audio" && kind !== "audio") { note("视频轨上的音频"); continue; }
      if (material.kind !== "audio" && kind === "audio") { note("音频轨上的画面"); continue; }
      const source = msRange(segment.source_timerange);
      const common = {
        id, src: `assets/${material.library}`, startMs: target.start, durationMs: target.duration,
        ...(source ? { trimStartMs: source.start } : {}), ...(speed !== 1 ? { speed } : {}),
        ...(clipAlpha < 1 ? { opacity: clipAlpha } : {}),
        ...(scale !== 1 || rotation !== 0 ? { transform: { ...(scale !== 1 ? { scale } : {}), ...(rotation !== 0 ? { rotate: rotation } : {}) } } : {}),
      };
      if (material.kind === "audio") clips.push({ ...common, kind: "audio", volume: 1 } as NleClip);
      else clips.push({ ...common, kind: material.kind } as NleClip);
    }
    if (!clips.length) continue;
    if (kind === "text") {
      // All caption segments share one text track (Glint keeps one per kind).
      if (textTrack) textTrack.clips.push(...clips);
      else textTrack = { id: trackId("t", usedTrackIds), kind: "text", name: "T1 文字(剪映)", clips };
    } else if (kind === "audio") {
      audioTracks.push({ id: trackId("a", usedTrackIds), kind: "audio", name: `A${audioTracks.length + 1} 音频(剪映)`, clips });
    } else {
      visualTracks.push({ id: trackId("v", usedTrackIds), kind: "overlay", name: `V${visualTracks.length + 1}(剪映)`, clips });
    }
  }
  for (const rawTrack of tracksInput) {
    const kind = typeof (rawTrack as DraftTrack).type === "string" ? (rawTrack as DraftTrack).type : "";
    if (kind === "sticker" || kind === "effect") note(`${kind} 轨道`);
    else if (kind === "filter") note("滤镜轨道");
  }

  // Bottom-first: main video, overlays in draft order (later paints higher), then text, then audio.
  const tracks: NleTrack[] = visualTracks.map((track, index) => index === 0
    ? { ...track, kind: "video" as const, name: "V1 主画面(剪映)" }
    : { ...track, kind: "overlay" as const, name: `V${index + 1} 叠加(剪映)` });
  if (textTrack) tracks.push(textTrack);
  tracks.push(...audioTracks);
  if (!tracks.length) throw new Error("草稿里没有可映射的片段（只支持视频/图片/音频/文字轨）");
  if (mapping.size) {
    const missing = [...mapping.values()].filter(item => !item.found);
    if (missing.length) warnings.push(`${missing.length} 个素材不在素材库，导入后请上传：${missing.map(item => item.original).slice(0, 6).join("、")}${missing.length > 6 ? " 等" : ""}`);
  }
  const skippedTotal = Object.entries(skipped).filter(([, count]) => count > 0);
  if (skippedTotal.length) warnings.push(`未导入：${skippedTotal.map(([key, count]) => `${key} ×${count}`).join("、")}（剪映特有，Glint 暂不支持）`);

  const project = parseNleProject({
    schemaVersion: 1, id: `jy-import-${Date.now().toString(36)}`.replace(/[^a-z0-9-]/g, "").slice(0, 40), title: "剪映导入", fps, width, height, background: "#08090b",
    tracks: tracks.map(track => ({ ...track, clips: track.clips.slice(0, 200) })).slice(0, 8),
  });
  return { project, mapping: [...mapping.values()], skipped, warnings };
}
