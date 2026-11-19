import type { SceneScriptProject } from "@glintai/scenescript";
import type { Series } from "@glintai/composer/drama-series";
import { applyStoryboard, applyStoryboardShot, storyboardShots } from "./storyboard-project";
import { Button } from "./ui/Button";
import { t } from "./ui/i18n";
import { StoryboardShotMedia } from "./StoryboardShotMedia";
import { useStoryboardLibrary } from "./storyboard-library";

type Props = {
  series: Series;
  episodeId: string;
  documentId: string;
  project: SceneScriptProject;
  onApply?(project: SceneScriptProject): void;
};
function applyDraft(
  props: Props,
  media: Record<string, string>,
  error: (message: string) => void,
  shot?: { id: string; index: number },
) {
  const { project, series, episodeId, documentId, onApply } = props;
  try {
    if (!onApply) throw new Error(t("storyboard.readOnly"));
    const next = shot
      ? applyStoryboardShot(project, series, episodeId, documentId, shot.id, media)
      : applyStoryboard(project, series, episodeId, documentId, media);
    const message = shot
      ? t("storyboard.replaceConfirm", { shot: shot.index })
      : t("storyboard.confirm", { before: project.scenes.length, after: next.scenes.length });
    if (!window.confirm(message)) return;
    onApply(next);
    error("");
  } catch (cause) {
    error(cause instanceof Error ? cause.message : t("storyboard.applyFailed"));
  }
}
function ApplyButtons({
  props,
  state,
  generated,
}: {
  props: Props;
  state: ReturnType<typeof useStoryboardLibrary>;
  generated: boolean;
}) {
  return (
    <>
      {generated && (
        <Button size="sm" disabled={state.loading} onClick={state.retry}>
          {t("storyboard.refreshMedia")}
        </Button>
      )}
      <Button
        size="sm"
        variant="primary"
        disabled={!props.onApply || props.project.frozen || (generated && state.loading)}
        onClick={() => applyDraft(props, state.media, state.setError)}
      >
        {t("storyboard.apply")}
      </Button>
    </>
  );
}
export function StoryboardApply(props: Props) {
  const { project, series, episodeId, documentId, onApply } = props;
  const rows = storyboardShots(series, episodeId, documentId),
    generated = rows.filter((row) => row.shot.engine === "aigc");
  const state = useStoryboardLibrary(
    `${project.id}:${documentId}:${episodeId}`,
    Boolean(generated.length),
  );
  const matches = rows.filter((row) => project.scenes.some((scene) => scene.id === row.id)).length;
  return (
    <section className="storyboard-apply" aria-label={t("storyboard.applyPanel")}>
      <h3>{t("storyboard.applyPanel")}</h3>
      <p>
        {t("storyboard.draftNotice", {
          planned: rows.length,
          applied: matches,
          actual: project.scenes.length,
        })}
      </p>
      {generated.map((row) => (
        <StoryboardShotMedia
          key={`${project.id}:${row.id}`}
          row={row}
          series={series}
          projectId={project.id}
          current={project.scenes.find((scene) => scene.id === row.id)}
          assets={state.assets}
          selected={state.media[row.id]}
          loading={state.loading}
          disabled={!onApply || Boolean(project.frozen)}
          onApply={() =>
            applyDraft(props, state.media, state.setError, { id: row.id, index: row.shot.index })
          }
          onSelect={(name) => state.select(row.id, name)}
        />
      ))}
      {state.error && <p role="alert">{state.error}</p>}
      <ApplyButtons props={props} state={state} generated={Boolean(generated.length)} />
    </section>
  );
}
