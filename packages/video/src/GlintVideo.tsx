import { resolveTheme } from "@glintai/design-tokens";
import { buildTimeline, parseProject, timelineToFrames } from "@glintai/scenescript";
import { Audio, AbsoluteFill, getInputProps, Sequence, staticFile, useCurrentFrame } from "remotion";
import { useMemo } from "react";
import { useFontGate } from "./components/useFontGate";
import { Caption } from "./components/Caption";
import { SceneShell } from "./components/SceneShell";
import { CameraFrame, TransitionIn } from "./components/SceneMotion";
import { placeSfx } from "./motion";
import { SceneRouter } from "./scenes";
import { SceneElements } from "./components/ElementOverlay";
import { NarrationAudio } from "./components/NarrationAudio";
import { cssVariablesStyle } from "./cssVariables";
import { SceneEffects } from "./components/SceneEffects";
import { MediaAssetProvider, type MediaAssetBase } from "./components/MediaAssetContext";

// Type alias (not interface) so the type satisfies Remotion's
// `Props extends Record<string, unknown>` constraint.
export type GlintProps = {
  /** A SceneScript v1 project (validated on render; invalid input fails loudly). */
  project: unknown;
  /**
   * Clean-plate export: strips captions, music and one-shot SFX so a video
   * editor can layer its own text/audio (JianYing hand-off). Visual scenes
   * stay byte-identical to the narrated cut.
   */
  plate?: boolean;
  /** Web library transport only; never stored in the SceneScript project. */
  mediaAssetBase?: MediaAssetBase;
};

// Centered hero layouts for title and quote scenes.
const CENTERED_KINDS = new Set(["title", "quote"]);

const ProgressBar: React.FC<{ durationInFrames: number }> = ({ durationInFrames }) => {
  const frame = useCurrentFrame();
  const progress = Math.min(1, frame / Math.max(1, durationInFrames - 1));
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        height: 6,
        background:
          "color-mix(in srgb, var(--glint-color-text) 8%, transparent)",
      }}
    >
      <div
        style={{
          height: "100%",
          width: `${progress * 100}%`,
          background:
            "var(--glint-color-accent)",
        }}
      />
    </div>
  );
};

export const GlintVideo: React.FC<GlintProps> = ({ project, plate, mediaAssetBase }) => {
  const parsed = useMemo(() => parseProject(project), [project]);
  const fps = parsed.fps ?? 30;
  const theme = resolveTheme(parsed.theme);
  useFontGate([theme.fonts.display, theme.fonts.body, theme.fonts.mono]);
  const { entries, durationInFrames } = useMemo(
    () => timelineToFrames(buildTimeline(parsed), fps),
    [parsed, fps],
  );
  const sfxPlacement = useMemo(
    () => (plate ? [] : placeSfx(parsed.sfx, entries.map((entry) => ({
      id: entry.scene.id,
      narration: entry.scene.narration,
      startFrame: entry.from,
    })), fps)),
    [parsed, entries, fps, plate],
  );

  return (
    <MediaAssetProvider mediaAssetBase={mediaAssetBase}>
    <AbsoluteFill
      style={{
        ...cssVariablesStyle(theme),
        background: "var(--glint-color-bg)",
        color: "var(--glint-color-text)",
        fontFamily: "var(--glint-font-body)",
      }}
    >
      {entries.map((entry) => (
        <Sequence
          key={entry.scene.id}
          from={entry.from}
          durationInFrames={entry.duration}
          name={`${entry.index + 1}. ${entry.scene.id}`}
        >
          <SceneEffects effects={entry.scene.effects} composited={entry.scene.kind === "html"}>
          <TransitionIn transition={entry.scene.transition}>
            <CameraFrame camera={entry.scene.camera} durationFrames={entry.duration}>
              <SceneShell
                fit={!["three", "html", "image", "video"].includes(entry.scene.kind)}
                align={CENTERED_KINDS.has(entry.scene.kind) ? "center" : "start"}
                kicker={
                  entry.scene.kind === "title"
                    ? undefined
                    : `${String(entry.index + 1).padStart(2, "0")} / ${String(entries.length).padStart(2, "0")}`
                }
              >
                <SceneRouter
                  scene={entry.scene}
                  colors={{
                    accent: theme.colors.accent,
                    accent2: theme.colors.accent2,
                    text: theme.colors.text,
                  }}
                />
              </SceneShell>
              {plate ? null : <SceneElements scene={entry.scene} />}
            </CameraFrame>
          </TransitionIn>
          {plate ? null : <Caption scene={entry.scene} sceneDurationFrames={entry.duration} />}
          </SceneEffects>
        </Sequence>
      ))}

      {entries.map(entry => (
        <NarrationAudio key={`narration-${entry.scene.id}`} scene={entry.scene}
          sceneStartFrame={entry.from} compositionDurationFrames={durationInFrames} />
      ))}

      {sfxPlacement.map((sfx, index) => (
        <Sequence key={`sfx-${index}`} from={Math.max(0, sfx.frame)} durationInFrames={Math.round(fps * 1.5)}>
          <Audio src={staticFile(`audio/sfx/${sfx.effect}.wav`)} volume={sfx.volume} />
        </Sequence>
      ))}

      {!plate && parsed.music ? (
        <Audio
          src={staticFile(parsed.music.src)}
          volume={parsed.music.volume ?? 0.12}
          loop
        />
      ) : null}
      <ProgressBar durationInFrames={entries.reduce((total, entry) => Math.max(total, entry.from + entry.duration), 1)} />
    </AbsoluteFill>
    </MediaAssetProvider>
  );
};
