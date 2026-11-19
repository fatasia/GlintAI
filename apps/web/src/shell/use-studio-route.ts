import { useEffect, useRef, useState } from "react";
import type { StudioView } from "./routes";

export interface StudioLocation { view: StudioView; projectId?: string }
export interface StudioRequest extends StudioLocation { nonce: number }

interface Options {
  /** Local restore has finished; requests before that would race the autosave restore. */
  ready: boolean;
  request?: StudioRequest;
  view: StudioView;
  /** SceneScript id of the project currently loaded in the editor. */
  projectId?: string;
  navigate(view: StudioView): void;
  /** Opens a saved project through the editor's own guards. Returns false when it does not exist. */
  openProject(projectId: string): boolean;
  onLocationChange?(location: StudioLocation): void;
}

// A guarded open may be declined (unsaved draft, confirm dialog); after this long
// the studio reports wherever it actually is, so the address bar never lies.
const SETTLE_MS = 1500;

function reached(target: StudioLocation, view: StudioView, projectId?: string): boolean {
  if (target.view !== view) return false;
  return target.view !== "workspace" || !target.projectId || target.projectId === projectId;
}

/**
 * Two-way sync between the hash route and the studio's internal view.
 * Requests flow in once per nonce; the studio's real location flows out, but not
 * while an accepted request is still settling (prevents the boot-time "home" from
 * overwriting a deep link before the project has opened).
 */
export function useStudioRoute({ ready, request, view, projectId, navigate, openProject, onLocationChange }: Options): void {
  const handled = useRef<number | undefined>(undefined);
  const pending = useRef<StudioLocation | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [settledTick, setSettledTick] = useState(0);

  useEffect(() => () => clearTimeout(timer.current), []);

  useEffect(() => {
    if (!ready || !request || handled.current === request.nonce) return;
    handled.current = request.nonce;
    const target: StudioLocation = { view: request.view, ...(request.projectId ? { projectId: request.projectId } : {}) };
    if (reached(target, view, projectId)) return;
    const settle = () => { pending.current = null; setSettledTick(value => value + 1); };
    pending.current = target;
    clearTimeout(timer.current);
    timer.current = setTimeout(settle, SETTLE_MS);
    if (target.view === "workspace" && target.projectId && target.projectId !== projectId) {
      if (!openProject(target.projectId)) { clearTimeout(timer.current); settle(); }
    } else {
      navigate(target.view);
    }
    // Deliberately keyed on the request only: view/project changes are reported below.
  }, [ready, request]);

  useEffect(() => {
    if (!ready || (request && handled.current !== request.nonce)) return;
    if (pending.current) {
      if (!reached(pending.current, view, projectId)) return;
      pending.current = null;
      clearTimeout(timer.current);
    }
    onLocationChange?.({ view, ...(view === "workspace" && projectId ? { projectId } : {}) });
  }, [ready, request, view, projectId, settledTick]);
}
