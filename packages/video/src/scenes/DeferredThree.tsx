import { useLayoutEffect, useRef, useState } from "react";
import { cancelRender, continueRender, delayRender } from "remotion";
import type { ThreeSceneView } from "./ThreeScene";
let loaded: typeof ThreeSceneView | null = null;
let loading: Promise<typeof import("./ThreeScene")> | null = null;
/** Load Three only for a 3D scene; hold capture until the component commits. */
export const DeferredThree: typeof ThreeSceneView = (props) => {
  const [View, setView] = useState(() => loaded);
  const gate = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (View) return;
    const handle = delayRender("glint-three-module"); gate.current = handle;
    let live = true, failed = false;
    loading ??= import("./ThreeScene");
    void loading.then((module) => {
      loaded = module.ThreeSceneView;
      if (live) setView(() => loaded);
    }).catch((error) => { loading = null; if (live) { failed = true; cancelRender(error); } });
    return () => { live = false; if (!failed && gate.current === handle) { continueRender(handle); gate.current = null; } };
  }, []);
  useLayoutEffect(() => {
    if (View && gate.current !== null) { continueRender(gate.current); gate.current = null; }
  }, [View]);
  return View ? <View {...props} /> : null;
};
