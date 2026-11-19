import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { Scene } from "@glintai/scenescript";
import { buildHtmlSceneDocument } from "../../../packages/video/src/scenes/html-runtime";
import { isolatedHtmlFrame } from "../../../packages/video/src/scenes/html-policy";
import { applicationUrl } from "./app-url";
import { t } from "./ui/i18n";
type HtmlScene = Extract<Scene, { kind: "html" }>;
function useFrameBridge(frame: RefObject<HTMLIFrameElement | null>, generation: string) {
  const [ready, setReady] = useState(false),
    [failed, setFailed] = useState(false);
  useLayoutEffect(() => {
    let sent = false,
      settled = false;
    const timer = window.setTimeout(() => {
      settled = true;
      setFailed(true);
    }, 10000);
    const listener = (event: MessageEvent) => {
      if (
        event.source !== frame.current?.contentWindow ||
        !event.data ||
        typeof event.data !== "object" ||
        event.data.generation !== generation ||
        settled
      )
        return;
      const data = event.data as { type?: unknown; requestId?: unknown; t?: unknown };
      if (data.type === "glint:ready" && !sent) {
        sent = true;
        frame.current?.contentWindow?.postMessage(
          { type: "glint:seek", generation, requestId: 1, t: 0 },
          "*",
        );
      } else if (
        sent &&
        data.requestId === 1 &&
        data.t === 0 &&
        (data.type === "glint:seeked" || data.type === "glint:seek-error")
      ) {
        settled = true;
        window.clearTimeout(timer);
        setFailed(data.type === "glint:seek-error");
        setReady(data.type === "glint:seeked");
      }
    };
    window.addEventListener("message", listener);
    return () => {
      settled = true;
      window.clearTimeout(timer);
      window.removeEventListener("message", listener);
    };
  }, [generation]);
  return { ready, failed };
}
function Frame({ scene }: { scene: HtmlScene }) {
  const frame = useRef<HTMLIFrameElement>(null),
    [generation] = useState(() => crypto.randomUUID());
  const { ready, failed } = useFrameBridge(frame, generation);
  const srcDoc = useMemo(() => {
    const runtime = new URL(applicationUrl("/three.runtime.js"), window.location.href).href;
    return isolatedHtmlFrame(
      buildHtmlSceneDocument(scene, runtime, generation),
      generation,
      true,
      runtime,
    );
  }, [scene, generation]);
  return (
    <>
      <iframe
        ref={frame}
        title={t("previz.title")}
        srcDoc={srcDoc}
        sandbox="allow-scripts"
        data-ready={ready}
      />
      {failed ? (
        <p role="alert">{t("previz.renderFailed")}</p>
      ) : (
        !ready && <p role="status">{t("previz.loading")}</p>
      )}
    </>
  );
}
function SizedFrame({ scene, aspect }: { scene: HtmlScene; aspect: "16:9" | "9:16" | "1:1" }) {
  const host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState("");
  useLayoutEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setSize(`${Math.round(width)}:${Math.round(height)}`);
    });
    observer.observe(host.current!);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={host} className="previz-frame" data-aspect={aspect}>
      <Frame key={`${scene.html}:${size}`} scene={scene} />
    </div>
  );
}
export default function StoryboardPrevizPreview({
  scene,
  aspect,
}: {
  scene: Scene;
  aspect: "16:9" | "9:16" | "1:1";
}) {
  if (scene.kind !== "html" || scene.animation !== "three")
    return <p role="alert">{t("previz.renderFailed")}</p>;
  return <SizedFrame scene={scene} aspect={aspect} />;
}
