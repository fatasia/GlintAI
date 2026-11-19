import { useState } from "react";
import { assertAllAuthoringCanLeave } from "./authoring-leave";

export function useStoryboardPrevizEntry() {
  const [selection, setSelection] = useState<{ sceneId: string; shotId: string } | null>(null);
  const [error, setError] = useState("");
  const guard = (action: () => void) => {
    try {
      assertAllAuthoringCanLeave();
      action();
      setError("");
    } catch (cause) {
      setError((cause as Error).message);
    }
  };
  return {
    selection,
    error,
    guard,
    open: (sceneId: string, shotId: string) => guard(() => setSelection({ sceneId, shotId })),
    close: () => guard(() => setSelection(null)),
  };
}
