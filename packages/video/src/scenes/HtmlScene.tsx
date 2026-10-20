import type { HtmlScene } from "@glintai/scenescript";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AbsoluteFill, cancelRender, continueRender, delayRender, staticFile,
  useCurrentFrame, useVideoConfig,
} from "remotion";
import { FadeIn } from "../components/FadeIn";
import { buildHtmlSceneDocument, GLINT_SEEK_MESSAGE_TYPE } from "./html-runtime";
import { isolatedHtmlFrame, staticHtmlDocument } from "./html-policy";

/** A changed document gets a new iframe and protocol generation. */
export const HtmlSceneView: React.FC<{ scene: HtmlScene }> = ({ scene }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return <HtmlDocument key={JSON.stringify([scene.animation, scene.html])} scene={scene} frame={frame} fps={fps} />;
};

const HtmlDocument: React.FC<{ scene: HtmlScene; frame: number; fps: number }> = ({ scene, frame, fps }) => {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const loaded = useRef(false);
  const sendSeek = useRef<(() => void) | null>(null);
  const requestSequence = useRef(0);
  const [generation] = useState(() => crypto.randomUUID());
  const gsapUrl = useMemo(() => staticFile(scene.animation === "three" ? "three.runtime.js" : scene.animation === "lottie" ? "lottie_light.min.js" : "gsap.min.js"), [scene.animation]);
  const animated = Boolean(scene.animation);
  const srcDoc = useMemo(
    () => isolatedHtmlFrame(animated ? buildHtmlSceneDocument(scene, gsapUrl, generation) : staticHtmlDocument(scene.html),generation,animated,animated?gsapUrl:undefined),
    [animated, scene.html, gsapUrl, generation],
  );

  useLayoutEffect(() => {
    // Block from mount, not just after onLoad: a cold iframe must never be
    // captured while it is still empty or at the timeline's default time.
    const handle = delayRender(`glint-html:${scene.id}:${frame}`, { timeoutInMilliseconds: 15_000 });
    const requestId = ++requestSequence.current;
    const seconds = frame / fps;
    let settled = false;
    let sent = false;
    const detach = () => {
      window.clearTimeout(timer);
      window.removeEventListener("message", onAck);
      sendSeek.current = null;
    };
    const release = () => {
      if (settled) return;
      settled = true;
      detach();
      continueRender(handle);
    };
    const fail = (reason: string) => {
      if (settled) return;
      settled = true;
      detach();
      // Do not release a failed frame. cancelRender reports the failure to
      // Remotion instead of throwing later from an unrelated timer callback.
      cancelRender(new Error(`HTML scene "${scene.id}" frame ${frame}: ${reason}`));
    };
    const onAck = (event: MessageEvent) => {
      const data = event.data;
      // A cold iframe can acquire a different WindowProxy as its document is
      // attached. Compare to the live ref, not the pre-load window snapshot.
      if (event.source !== iframeRef.current?.contentWindow || !data || data.generation !== generation) return;
      if (data.type === "glint:ready") {
        loaded.current = true;
        sendSeek.current?.();
        return;
      }
      if (!sent ||
          data.requestId !== requestId || data.t !== seconds) return;
      if (data.type === "glint:seek-error") fail(String(data.error ?? "seek failed").slice(0, 500));
      else if (data.type === "glint:seeked") release();
    };
    const timer = window.setTimeout(() => fail("document/seek readiness timed out after 10s"), 10_000);
    window.addEventListener("message", onAck);
    sendSeek.current = () => {
      if (settled || sent || !loaded.current) return;
      if (!animated) { release(); return; }
      const win = iframeRef.current?.contentWindow;
      if (!win) { fail("iframe window unavailable"); return; }
      sent = true;
      try {
        win.postMessage({ type: GLINT_SEEK_MESSAGE_TYPE, generation, requestId, t: seconds }, "*");
      } catch (error) { fail(String(error)); }
    };
    sendSeek.current();
    return () => {
      detach();
      if (!settled) { settled = true; continueRender(handle); }
    };
  }, [frame, fps, animated, scene.id, generation]);

  return (
    <AbsoluteFill
      style={{
        padding: "150px 170px 330px",
        display: "flex",
        flexDirection: "column",
        gap: 44,
      }}
    >
      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
        <iframe
          ref={iframeRef}
          title={`html-scene-${scene.id}`}
          srcDoc={srcDoc}
          sandbox="allow-scripts"
          onLoad={() => {
            // Animated documents identify themselves with glint:ready. A load
            // event alone can belong to the iframe's initial about:blank page.
            if (!animated) { loaded.current = true; sendSeek.current?.(); }
          }}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            border: "none",
            borderRadius: "var(--glint-radius)",
            background: scene.background ?? "transparent",
            boxShadow: "var(--glint-shadow-card)",
          }}
        />
      </div>
      {scene.caption ? (
        <FadeIn delay={8} style={{ flexShrink: 0 }}>
          <p
            style={{
              margin: 0,
              textAlign: "center",
              fontSize: "var(--glint-font-size-body)",
              lineHeight: 1.5,
              color: "var(--glint-color-text-muted)",
            }}
          >
            {scene.caption}
          </p>
        </FadeIn>
      ) : null}
    </AbsoluteFill>
  );
};
