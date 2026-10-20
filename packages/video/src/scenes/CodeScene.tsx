import type { CodeScene } from "@glintai/scenescript";
import { FadeIn } from "../components/FadeIn";
import { Heading } from "../components/Heading";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { estimateNarrationDurationMs } from "@glintai/scenescript";
export function codePages(code: string, columns: number, rows: number): string[] {
  const wrapped: string[] = [];
  for (const line of code.split("\n")) {
    let part = "", width = 0;
    for (const char of line) {
      const size = /[^\x00-\x7f]/.test(char) ? 2 : char === "\t" ? 4 : 1;
      if (part && width + size > columns) { wrapped.push(part); part = ""; width = 0; }
      part += char; width += size;
    }
    wrapped.push(part);
  }
  const pages: string[] = [];
  for (let i = 0; i < wrapped.length; i += rows) pages.push(wrapped.slice(i, i + rows).join("\n"));
  return pages;
}

export const CodeSceneView: React.FC<{ scene: CodeScene }> = ({ scene }) => {
  const { width, height, fps } = useVideoConfig(), frame = useCurrentFrame();
  const side = width / height < 1.3 ? 76 : 170;
  const pages = codePages(scene.code, Math.max(16, Math.floor((width - side * 2 - 88) / 17)), Math.max(4, Math.floor((height - 800) / 45)));
  const duration = scene.narration.durationMs ?? estimateNarrationDurationMs(scene.narration.text);
  const page = Math.min(pages.length - 1, Math.floor(Math.max(0, frame / fps * 1000) / Math.max(1, duration) * pages.length));
  return (
    <>
      {scene.heading ? (
        <FadeIn>
          <Heading>{scene.heading}</Heading>
        </FadeIn>
      ) : null}
      <FadeIn delay={6} style={{ width: "100%" }}>
        <div
          style={{
            width: "100%",
            background: "var(--glint-color-surface)",
            border:
              "1px solid color-mix(in srgb, var(--glint-color-text) 10%, transparent)",
            borderRadius: "var(--glint-radius)",
            boxShadow: "var(--glint-shadow-card)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "20px 32px",
              borderBottom:
                "1px solid color-mix(in srgb, var(--glint-color-text) 8%, transparent)",
            }}
          >
            {[0, 1, 2].map((dot) => (
              <span
                key={dot}
                style={{
                  width: 13,
                  height: 13,
                  borderRadius: "50%",
                  background:
                    "color-mix(in srgb, var(--glint-color-text) 16%, transparent)",
                }}
              />
            ))}
            {scene.language ? (
              <span
                style={{
                  marginLeft: "auto",
                  fontFamily: "var(--glint-font-mono)",
                  fontSize: 22,
                  color: "var(--glint-color-text-muted)",
                }}
              >
                {scene.language}{pages.length > 1 ? ` · ${page + 1}/${pages.length}` : ""}
              </span>
            ) : null}
          </div>
          <pre
            style={{
              margin: 0,
              padding: 44,
              fontFamily: "var(--glint-font-mono)",
              fontSize: 28,
              lineHeight: 1.6,
              whiteSpace: "pre",
              overflow: "hidden",
            }}
          >
            {pages[page]}
          </pre>
        </div>
      </FadeIn>
      {scene.caption ? (
        <FadeIn delay={12}>
          <p
            style={{
              margin: 0,
              fontSize: "var(--glint-font-size-body)",
              color: "var(--glint-color-text-muted)",
            }}
          >
            {scene.caption}
          </p>
        </FadeIn>
      ) : null}
    </>
  );
};
