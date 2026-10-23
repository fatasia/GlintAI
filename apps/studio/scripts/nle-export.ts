import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildTimeline, frameRateOf, framesForMs, nleDurationMs, type NleProject, type SceneScriptProject } from "@glintai/scenescript";

/**
 * Timeline interchange for a rendered Glint master: scene boundaries become
 * cuts in one asset, so an editor can trim, regrade or re-time each shot.
 *
 * EXPERIMENTAL, honestly scoped: the FCPXML 1.9 and CMX3600 EDL layouts follow
 * the public formats, but neither has been opened in Final Cut, Premiere or
 * Resolve on this machine (2026-10). EDL is non-drop-frame and therefore
 * approximate for 23.976/29.97/59.94 projects; FCPXML keeps exact frame
 * rationals.
 */

export interface NleSpec { width: number; height: number; fps: number }

export interface NleCut {
  index: number;
  sceneId: string;
  title: string;
  startFrame: number;
  endFrame: number;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function cutNames(project: SceneScriptProject): NleCut[] {
  const fps = project.fps ?? 30;
  const rate = frameRateOf(fps);
  const timeline = buildTimeline(project);
  const starts = timeline.entries.map(entry => framesForMs(entry.startMs, rate));
  const totalFrames = Math.max(1, framesForMs(timeline.totalMs, rate));
  return timeline.entries.map((entry, index) => ({
    index,
    sceneId: entry.scene.id,
    title: "title" in entry.scene && typeof entry.scene.title === "string" ? entry.scene.title : entry.scene.id,
    startFrame: starts[index]!,
    endFrame: Math.max(starts[index]! + 1, starts[index + 1] ?? totalFrames),
  }));
}

function gcd(a: number, b: number): number { return b === 0 ? a : gcd(b, a % b); }
function rational(rate: ReturnType<typeof frameRateOf>, frames: number): string {
  if (frames <= 0) return "0s";
  const numerator = frames * rate.denominator, denominator = rate.numerator, divisor = gcd(numerator, denominator);
  const n = numerator / divisor, d = denominator / divisor;
  return d === 1 ? `${n}s` : `${n}/${d}s`;
}

export function buildFcpxml(project: SceneScriptProject, videoPath: string, outputPath: string, spec?: NleSpec): string {
  const rate = frameRateOf(project.fps ?? 30);
  const cuts = cutNames(project);
  const totalFrames = cuts.at(-1)?.endFrame ?? 1;
  const source = pathToFileURL(videoPath).href.replace(/^file:\/\//, "file://localhost");
  const formatName = escapeXml(`Glint ${project.aspect} ${project.fps ?? 30}fps`);
  const assetName = escapeXml(project.title);
  const dimensions = spec ? [spec.width, spec.height] : project.aspect === "16:9" ? [1920, 1080] : project.aspect === "9:16" ? [1080, 1920] : [1080, 1080];
  const hasAudio = Boolean(project.music) || project.scenes.some(scene => scene.narration.audioRef);
  const clip = (cut: NleCut) => `          <asset-clip ref="r2" offset="${rational(rate, cut.startFrame)}" start="${rational(rate, cut.startFrame)}" duration="${rational(rate, cut.endFrame - cut.startFrame)}" name="${escapeXml(`${String(cut.index + 1).padStart(2, "0")} ${cut.title}`)}" />`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.9">
  <resources>
    <format id="r1" name="${formatName}" frameDuration="${rational(rate, 1)}" width="${dimensions[0]}" height="${dimensions[1]}" />
    <asset id="r2" name="${assetName}" start="0s" duration="${rational(rate, totalFrames)}" hasVideo="1" hasAudio="${hasAudio ? 1 : 0}" format="r1">
      <media-rep kind="original-media" src="${escapeXml(source)}" />
    </asset>
  </resources>
  <library>
    <event name="Glint">
      <project name="${assetName}">
        <sequence format="r1" duration="${rational(rate, totalFrames)}" tcStart="0s" tcFormat="NDF">
          <spine>
${cuts.map(clip).join("\n")}
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
`;
}

function timecode(frame: number, nominalFps: number): string {
  const sign = frame < 0 ? "-" : "";
  const absolute = Math.abs(frame);
  const fps = Math.max(1, Math.round(nominalFps));
  const frames = absolute % fps;
  const totalSeconds = Math.floor(absolute / fps);
  const seconds = totalSeconds % 60, minutes = Math.floor(totalSeconds / 60) % 60, hours = Math.floor(totalSeconds / 3600);
  return `${sign}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}:${String(frames).padStart(2, "0")}`;
}

export function buildEdl(project: SceneScriptProject, videoPath: string, outputPath: string, spec?: NleSpec): string {
  const cuts = cutNames(project);
  const fps = spec?.fps ?? project.fps ?? 30;
  const clipName = (cut: NleCut) => `SCENE_${String(cut.index + 1).padStart(2, "0")}_${cut.title.replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]+/g, "_").slice(0, 40)}`;
  const lines = [
    `TITLE: ${project.title}`,
    "FCM: NON-DROP FRAME",
    "",
    ...cuts.flatMap(cut => {
      const event = String(cut.index + 1).padStart(3, "0");
      const from = timecode(cut.startFrame, fps), to = timecode(cut.endFrame, fps);
      return [`${event}  AX       V     C        ${from} ${to} ${from} ${to}`, `* FROM CLIP NAME: ${clipName(cut)}`, `* SOURCE FILE: ${path.basename(videoPath)}`, ""];
    }),
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * Edit-decision interchange for the multi-track editor. Unlike the SceneScript
 * path above there is no master render: every timeline clip becomes its own
 * event pointing at its own source file. Text clips cannot be expressed in
 * CMX3600/FCPXML as media, so they are counted and reported instead of dropped
 * silently.
 */
export interface NleTimelineExport { text: string; clips: number; textClips: number; audioClips: number }

export function buildNleFcpxml(project: NleProject, assetPath: (name: string) => string = name => name): NleTimelineExport {
  const rate = frameRateOf(project.fps);
  const frames = (ms: number, minimum = 0) => Math.max(minimum, Math.round(ms / 1000 * project.fps));
  const total = frames(nleDurationMs(project), 1);
  const assets = new Map<string, string>();
  const assetId = (name: string) => {
    if (!assets.has(name)) assets.set(name, `a${assets.size + 1}`);
    return assets.get(name)!;
  };
  let textClips = 0, audioClips = 0;
  const media = (src: string) => `file://localhost${assetPath(src.slice("assets/".length)).replace(/\\/g, "/").replace(/^\/*/, "/")}`;
  const visual: string[] = [];
  for (const [trackIndex, track] of project.tracks.entries()) {
    if (track.kind === "audio" || track.muted) continue;
    const lane = track.kind === "video" ? 0 : trackIndex;
    for (const clip of track.clips) {
      if (clip.kind === "text") { textClips++; continue; }
      const ref = assetId(clip.src);
      visual.push(`          <asset-clip ref="${ref}" lane="${lane}" offset="${rational(rate, frames(clip.startMs))}" start="${rational(rate, frames(clip.trimStartMs ?? 0))}" duration="${rational(rate, frames(clip.durationMs, 1))}" name="${escapeXml(clip.id)}" />`);
    }
  }
  const audio: string[] = [];
  for (const track of project.tracks) {
    if (track.kind !== "audio" || track.muted) continue;
    for (const clip of track.clips) {
      if (clip.kind !== "audio") continue;
      audioClips++;
      audio.push(`          <asset-clip ref="${assetId(clip.src)}" lane="-1" offset="${rational(rate, frames(clip.startMs))}" start="${rational(rate, frames(clip.trimStartMs ?? 0))}" duration="${rational(rate, frames(clip.durationMs, 1))}" name="${escapeXml(clip.id)}" audioRole="effects" />`);
    }
  }
  const resources = [...assets.entries()].map(([name, id]) => `    <asset id="${id}" name="${escapeXml(path.basename(name))}" start="0s" duration="${rational(rate, Math.max(1, total))}" hasVideo="1" hasAudio="${/\.(mp4|mov|m4v)$/i.test(name) ? 1 : 0}" format="r1">
      <media-rep kind="original-media" src="${escapeXml(media(name))}" />
    </asset>`).join("\n");
  const text = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.9">
  <resources>
    <format id="r1" name="Glint NLE ${escapeXml(String(project.fps))}fps" frameDuration="${rational(rate, 1)}" width="${project.width}" height="${project.height}" />
${resources}
  </resources>
  <library>
    <event name="Glint NLE">
      <project name="${escapeXml(project.title)}">
        <sequence format="r1" duration="${rational(rate, Math.max(1, total))}" tcStart="0s" tcFormat="NDF">
          <spine>
${[...visual, ...audio].join("\n")}
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
`;
  return { text, clips: visual.length + audio.length, textClips, audioClips };
}

export function buildNleEdl(project: NleProject): NleTimelineExport {
  const fps = project.fps;
  const frames = (ms: number) => Math.max(0, Math.round(ms / 1000 * fps));
  const events: { start: number; clip: { id: string; startMs: number; durationMs: number; trimStartMs?: number; speed?: number }; track: string }[] = [];
  let textClips = 0, audioClips = 0;
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (clip.kind === "text") { textClips++; continue; }
      if (clip.kind === "audio") { audioClips++; continue; }
      events.push({ start: clip.startMs, clip, track: track.name });
    }
  }
  events.sort((a, b) => a.start - b.start || a.clip.id.localeCompare(b.clip.id));
  const lines = [
    `TITLE: ${project.title}`,
    "FCM: NON-DROP FRAME",
    "",
    ...events.flatMap(({ clip, track }, index) => {
      const event = String(index + 1).padStart(3, "0");
      // Source range must advance at timeline speed: a 2x clip consumes twice the source frames.
      const sourceIn = timecode(frames(clip.trimStartMs ?? 0), fps), sourceOut = timecode(frames((clip.trimStartMs ?? 0) + clip.durationMs * (clip.speed ?? 1)), fps);
      const recordIn = timecode(frames(clip.startMs), fps), recordOut = timecode(frames(clip.startMs + clip.durationMs), fps);
      return [`${event}  AX       V     C        ${sourceIn} ${sourceOut} ${recordIn} ${recordOut}`, `* FROM CLIP NAME: ${clip.id}`, `* TRACK: ${track}`, ""];
    }),
    ...(audioClips ? [`* AUDIO CLIPS OMITTED FROM CMX3600: ${audioClips}`] : []),
    ...(textClips ? [`* TEXT CLIPS OMITTED FROM CMX3600: ${textClips}`] : []),
  ];
  return { text: `${lines.join("\n")}\n`, clips: events.length, textClips, audioClips };
}

export function exportNleProjectTimeline({ project, format, outPath, assetPath }: {
  project: NleProject; format: "fcpxml" | "edl"; outPath: string; assetPath?: (name: string) => string;
}): { file: string; bytes: number; clips: number; textClips: number; audioClips: number; warning?: string } {
  const result = format === "fcpxml" ? buildNleFcpxml(project, assetPath) : buildNleEdl(project);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, result.text, "utf8");
  return { file: outPath, bytes: fs.statSync(outPath).size, clips: result.clips, textClips: result.textClips, audioClips: result.audioClips,
    warning: result.textClips ? `文字片段（${result.textClips}）不能写入 ${format.toUpperCase()}，需在剪辑软件里重建。` : undefined };
}

export function exportNleTimeline({ project, videoPath, format, outPath, spec }: {
  project: SceneScriptProject; videoPath: string; format: "fcpxml" | "edl"; outPath: string; spec?: NleSpec;
}): { file: string; cuts: number; bytes: number; warning?: string } {
  const text = format === "fcpxml" ? buildFcpxml(project, videoPath, outPath, spec) : buildEdl(project, videoPath, outPath, spec);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, text, "utf8");
  return {
    file: outPath,
    cuts: cutNames(project).length,
    bytes: fs.statSync(outPath).size,
    warning: format === "edl" && Math.abs((project.fps ?? 30) - Math.round(project.fps ?? 30)) > 0.001
      ? "EDL 使用非丢帧时间码；29.97/23.976 项目在长片中可能漂移，优先用 FCPXML。"
      : undefined,
  };
}
