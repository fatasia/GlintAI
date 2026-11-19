import { useEffect, useState } from "react";
import { appFetch as fetch } from "./app-url";
import { libraryVisual, type LibraryVisual } from "./media-adoption";
import { t } from "./ui/i18n";
async function loadVisuals(signal: AbortSignal) {
  const response = await fetch("/api/media/library", { signal }),
    data = await response.json();
  if (!response.ok || !Array.isArray(data.assets)) throw new Error(t("storyboard.libraryFailed"));
  const list: LibraryVisual[] = [];
  for (const asset of data.assets.slice(0, 5000))
    try {
      list.push(libraryVisual(asset.name));
    } catch {
      /* Non-visual assets are not candidates. */
    }
  return list;
}
export function useStoryboardLibrary(identity: string, enabled: boolean) {
  const [assets, setAssets] = useState<LibraryVisual[]>([]),
    [media, setMedia] = useState<Record<string, string>>({});
  const [error, setError] = useState(""),
    [retry, setRetry] = useState(0),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    setMedia({});
    setError("");
  }, [identity]);
  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    void loadVisuals(controller.signal)
      .then((list) => {
        if (!controller.signal.aborted) {
          setAssets(list);
          setError("");
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : t("storyboard.libraryFailed"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [enabled, retry]);
  const select = (id: string, name: string) => {
    if (name) {
      const asset = libraryVisual(name);
      setAssets((list) => (list.some((item) => item.name === name) ? list : [...list, asset]));
    }
    setMedia((value) => ({ ...value, [id]: name }));
    setError("");
  };
  return {
    assets,
    media,
    error,
    setError,
    loading,
    select,
    retry: () => setRetry((value) => value + 1),
  };
}
