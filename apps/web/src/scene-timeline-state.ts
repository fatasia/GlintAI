import { useEffect, useState } from "react";
import {
  buildTimeline,
  editTimeline,
  type SceneScriptProject,
  type TimelineCommand,
} from "@glintai/scenescript";
import { t } from "./ui/i18n";
import type { TimelinePanelProps } from "./TimelinePanel";

function refusal(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/locked/.test(message)) return t("st.errorLocked");
  if (/audio|narration timings/.test(message)) return t("st.errorAudio");
  if (/animation|dynamic|continuity|transition|SFX/.test(message)) return t("st.errorEffects");
  if (/duplicateText/.test(message)) return t("st.errorDuplicate");
  if (/100ms/.test(message)) return t("st.errorShort");
  if (/safe integer/.test(message)) return t("st.errorPosition");
  if (/last scene/.test(message)) return t("st.errorLast");
  if (/next scene/.test(message)) return t("st.errorNext");
  if (/bounds|handles/.test(message)) return t("st.errorBounds");
  return t("st.error");
}

export function useSceneTimeline({
  project,
  selectedSceneId,
  onChange,
  onSelect,
}: TimelinePanelProps) {
  const timeline = buildTimeline(project);
  const [localSelection, setLocalSelection] = useState(selectedSceneId);
  const [splitMs, setSplitMs] = useState("500");
  const [duplicateText, setDuplicateText] = useState(false);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null);
  useEffect(() => {
    setLocalSelection(selectedSceneId);
  }, [selectedSceneId]);
  const current =
    timeline.entries.find(
      (entry) => entry.scene.id === (onSelect ? selectedSceneId : localSelection),
    ) ?? timeline.entries[0];
  const scene = current?.scene;
  useEffect(() => {
    setDuplicateText(false);
  }, [scene?.id]);
  const select = (id: string) => {
    setLocalSelection(id);
    onSelect?.(id);
  };
  const execute = (command: TimelineCommand, success: string) => {
    let next: SceneScriptProject;
    try {
      next = editTimeline(project, command);
    } catch (error) {
      setFeedback({ error: true, text: refusal(error) });
      return;
    }
    onChange(next);
    if (command.type === "ripple-delete") {
      const neighbor = next.scenes[Math.min(current?.index ?? 0, next.scenes.length - 1)];
      if (neighbor) select(neighbor.id);
    }
    if (command.type === "split") setDuplicateText(false);
    setFeedback({ error: false, text: success });
  };
  const split = () =>
    splitCurrent(scene?.id, splitMs, duplicateText, execute, () =>
      setFeedback({ error: true, text: t("st.errorPosition") }),
    );
  return {
    timeline,
    scene,
    select,
    execute,
    splitMs,
    setSplitMs,
    duplicateText,
    setDuplicateText,
    feedback,
    split,
  };
}

export type SceneTimelineState = ReturnType<typeof useSceneTimeline>;

function splitCurrent(
  sceneId: string | undefined,
  position: string,
  duplicateText: boolean,
  execute: (command: TimelineCommand, message: string) => void,
  invalid: () => void,
) {
  if (!sceneId) return;
  if (!position.trim()) {
    invalid();
    return;
  }
  execute(
    {
      type: "split",
      sceneId,
      atMs: Number(position),
      newSceneId: `split-${crypto.randomUUID()}`,
      duplicateText,
    },
    t("st.didSplit"),
  );
}
