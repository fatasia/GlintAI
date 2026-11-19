import { lazy, Suspense, useState } from "react";
import { managedVideoName } from "./media-work-start";
import { Button } from "./ui/Button";
import { t } from "./ui/i18n";

const MediaWorkshop = lazy(() => import("./MediaWorkshop").then(module => ({ default: module.MediaWorkshop })));

/** Candidate selection only. The parent applies the draft through its existing transaction. */
export function StoryboardVideo({ identity, prompt, disabled, onSelect }: {
  identity: string; prompt: string; disabled: boolean; onSelect(name: string): void;
}) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  return <div>
    <Button size="sm" disabled={disabled || busy} aria-expanded={open} onClick={() => setOpen(value => !value)}>{t(open ? "storyboard.closeVideo" : "storyboard.generateVideo")}</Button>
    {open && <Suspense fallback={<p role="status">{t("workspace.loading")}</p>}>
      <MediaWorkshop key={identity} initialType="video" initialPrompt={prompt} useVideoLabel={t("storyboard.bindVideo")} taskStorageKey={`glint.storyboard-task.v1:${identity}`} disabled={disabled} onBusyChange={setBusy} onUseVideo={async asset => {
        if (disabled) return;
        try { const name = managedVideoName(asset.url); onSelect(name); setOpen(false); setBusy(false); setError(""); }
        catch (cause) { setError(cause instanceof Error ? cause.message : t("storyboard.libraryFailed")); }
      }} />
    </Suspense>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
