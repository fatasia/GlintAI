import { assertAllAuthoringCanLeave } from "./authoring-leave";
import { TimelineDock } from "./TimelineDock";
import { TimelinePanel, type TimelinePanelProps } from "./TimelinePanel";
import { t } from "./ui/i18n";

export function SceneTimelineDock(props: TimelinePanelProps) {
  return (
    <TimelineDock storageKey={`scene:${props.project.id}`} label={t("timelineDock.scene")}>
      <TimelinePanel {...props} compact />
    </TimelineDock>
  );
}

export function guardWorkspaceViewChange(
  event: Pick<MouseEvent, "target" | "preventDefault" | "stopPropagation">,
  notify: (message: string) => void,
  onlyLeavingView = false,
): boolean {
  if (
    onlyLeavingView &&
    (!(event.target instanceof Element) ||
      event.target.closest("button")?.getAttribute("aria-pressed") === "true")
  )
    return true;
  try {
    assertAllAuthoringCanLeave();
    return true;
  } catch (cause) {
    event.preventDefault();
    event.stopPropagation();
    notify(cause instanceof Error ? cause.message : t("timelineDock.blocked"));
    return false;
  }
}
