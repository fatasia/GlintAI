import { resolveTheme } from "@glintai/design-tokens";
import { buildTimeline, parseProject, timelineToFrames } from "@glintai/scenescript";
import { Audio, AbsoluteFill, Sequence, staticFile, useCurrentFrame } from "remotion";
import { useMemo } from "react";
import { useFontGate } from "./components/useFontGate";
import { Caption } from "./components/Caption";
import { SceneShell } from "./components/SceneShell";
import { SceneRouter } from "./scenes";
import { cssVariablesStyle } from "./cssVariables";

// Type alias (not interface) so the type satisfies Remotion's
// `Props extends Record<string, unknown>` constraint.
export type GlintProps = {
  /** A SceneScript v1 project (validated on render; invalid input fails loudly). */
  project: unknown;
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

export const GlintVideo: React.FC<GlintProps> = ({ project }) => {
  const parsed = useMemo(() => parseProject(project), [project]);
  const fps = parsed.fps ?? 30;
  const theme = resolveTheme(parsed.theme);
  useFontGate([theme.fonts.display, theme.fonts.body, theme.fonts.mono]);
  const { entries } = useMemo(
    () => timelineToFrames(buildTimeline(parsed), fps),
    [parsed, fps],
  );


  return (
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
          <SceneShell
            fit={!["three", "html", "image"].includes(entry.scene.kind)}
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
          <Caption scene={entry.scene} sceneDurationFrames={entry.duration} />
          {entry.scene.narration.audioRef ? (
            <Audio src={staticFile(entry.scene.narration.audioRef)} />
          ) : null}
        </Sequence>
      ))}

      {parsed.music ? (
        <Audio
          src={staticFile(parsed.music.src)}
          volume={parsed.music.volume ?? 0.12}
          loop
        />
      ) : null}
      <ProgressBar durationInFrames={entries.reduce((total, entry) => Math.max(total, entry.from + entry.duration), 1)} />
    </AbsoluteFill>
  );
};
