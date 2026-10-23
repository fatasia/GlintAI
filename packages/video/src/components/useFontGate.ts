import { useLayoutEffect } from "react";
import { cancelRender, continueRender, delayRender } from "remotion";

/** Keep the content mounted while font discovery and loading complete. */
export function useFontGate(fonts: string[]): void {
  const key = JSON.stringify(fonts);
  useLayoutEffect(() => {
    // Each effect owns its handle, including StrictMode's setup/cleanup replay
    // and theme changes. Reusing a released handle would leave fonts ungated.
    const handle = delayRender("Loading composition fonts", { timeoutInMilliseconds: 15_000 });
    let active = true;
    let failed = false;
    let released = false;
    if (!document.fonts?.load) { released = true; continueRender(handle); return; }
    void (async () => {
      try {
        const families = JSON.parse(key) as string[];
        await Promise.all(families.map((family) => document.fonts.load(`36px ${family}`, "中文 Aa 123")));
        await document.fonts.ready;
        if (active) { released = true; continueRender(handle); }
      } catch (error) {
        if (active) {
          failed = true;
          cancelRender(new Error(`Font loading failed: ${String(error)}`));
        }
      }
    })();
    return () => { active = false; if (!failed && !released) continueRender(handle); };
  }, [key]);
}
