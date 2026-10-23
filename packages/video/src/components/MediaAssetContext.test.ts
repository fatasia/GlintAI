import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseProject } from "@glintai/scenescript";
import { staticFile } from "remotion";
import { MediaAssetProvider, resolveMediaAssetSrc, type MediaAssetBase } from "./MediaAssetContext";
import { ImageSceneView } from "../scenes/ImageScene";
import { VideoSceneView } from "../scenes/VideoScene";
import { GlintVideo } from "../GlintVideo";

vi.mock("remotion", () => ({
  staticFile: vi.fn((src: string) => `/remotion-public/${src}`),
  useVideoConfig: () => ({ width: 1920, height: 1080, fps: 30 }),
  useCurrentFrame: () => 0,
  spring: () => 1,
  AbsoluteFill: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  Sequence: ({ children }: { children: ReactNode }) => createElement("section", null, children),
  Img: ({ src }: { src: string }) => createElement("img", { src }),
  OffthreadVideo: ({ src, muted, startFrom, endAt, playbackRate }: {
    src: string; muted: boolean; startFrom: number; endAt: number; playbackRate: number;
  }) => createElement("video", { src, muted, "data-start": startFrom, "data-end": endAt, "data-speed": playbackRate }),
  Audio: ({ src }: { src: string }) => createElement("audio", { src }),
}));
vi.mock("./useFontGate", () => ({ useFontGate: () => {} }));
vi.mock("./SceneShell", () => ({ SceneShell: ({ children }: { children: ReactNode }) => children }));
vi.mock("../scenes", () => ({
  SceneRouter: ({ scene }: { scene: Parameters<typeof ImageSceneView>[0]["scene"] | Parameters<typeof VideoSceneView>[0]["scene"] }) =>
    scene.kind === "image" ? createElement(ImageSceneView, { scene }) : createElement(VideoSceneView, { scene }),
}));

const base: MediaAssetBase = "/api/media/assets/";
beforeEach(() => vi.mocked(staticFile).mockClear());

describe("portable media asset resolver", () => {
  it.each(["still.png", "photo.jpg", "frame.webp", "clip.mp4", `${"a".repeat(100)}.png`, "task_12-final.png"])(
    "maps library basename %s without calling staticFile", name => {
      expect(resolveMediaAssetSrc(`assets/${name}`, base)).toBe(`${base}${encodeURIComponent(name)}`);
      expect(staticFile).not.toHaveBeenCalled();
    },
  );

  it.each(["assets/photo.png", "assets/clip.mp4", "assets/nested/photo.png", "assets/my photo.png"])(
    "preserves the CLI/staticFile default for %s", src => {
      expect(resolveMediaAssetSrc(src)).toBe(`/remotion-public/${src}`);
      expect(vi.mocked(staticFile).mock.calls).toEqual([[src]]);
    },
  );

  it.each([
    "assets/nested/photo.png", "assets/nested/clip.mp4", "assets/my photo.png", "assets/图像.png",
    "assets/photo.jpeg", "assets/photo.PNG", "assets/a.b.png", "assets/sound.mp3", "assets/scene.glb",
    `assets/${"a".repeat(101)}.png`,
  ])("does not remap other valid local paths: %s", src => {
    expect(resolveMediaAssetSrc(src, base)).toBe(`/remotion-public/${src}`);
    expect(vi.mocked(staticFile).mock.calls).toEqual([[src]]);
  });

  it.each([
    "", "https://example.com/photo.png", "http://example.com/clip.mp4", "//example.com/photo.png",
    "/assets/photo.png", "/api/media/assets/photo.png", "data:image/png;base64,abc", "assets/../photo.png",
    "assets/./photo.png", "assets/nested/../../photo.png", "assets//photo.png", "assets\\photo.png",
    "assets/%2e%2e/photo.png", "assets/photo.png?url=remote", "assets/photo.png#fragment", "assets/con.png",
    "assets/photo.png\n",
  ])("rejects unsafe input before any transport resolution: %s", src => {
    expect(() => resolveMediaAssetSrc(src)).toThrow();
    expect(() => resolveMediaAssetSrc(src, base)).toThrow();
    expect(staticFile).not.toHaveBeenCalled();
  });

  it("ignores an arbitrary runtime base even when callers bypass the literal prop type", () => {
    expect(resolveMediaAssetSrc("assets/photo.png", "https://example.com/" as MediaAssetBase)).toBe("/remotion-public/assets/photo.png");
    expect(vi.mocked(staticFile).mock.calls).toEqual([["assets/photo.png"]]);
  });
});

const image = { id: "image", kind: "image" as const, src: "assets/photo.png", narration: { text: "Image", durationMs: 2000 } };
const video = { id: "video", kind: "video" as const, src: "assets/clip.mp4", trimStartSec: 0.5, trimEndSec: 2.5,
  speed: 2, narration: { text: "Video", durationMs: 1000 } };
const views = () => [createElement(ImageSceneView, { key: "image", scene: image }), createElement(VideoSceneView, { key: "video", scene: video })];

describe("media provider and scene source wiring", () => {
  it("passes library URLs directly into image/video components without double staticFile mapping", () => {
    const markup = renderToStaticMarkup(createElement(MediaAssetProvider, { mediaAssetBase: base, children: views() }));
    expect(markup).toContain('src="/api/media/assets/photo.png"');
    expect(markup).toContain('src="/api/media/assets/clip.mp4"');
    expect(markup).toContain('data-start="15"');
    expect(markup).toContain('data-end="75"');
    expect(markup).toContain('data-speed="2"');
    expect(markup).toContain('muted=""');
    expect(staticFile).not.toHaveBeenCalled();
  });

  it("keeps both scenes on staticFile without a provider", () => {
    const markup = renderToStaticMarkup(createElement("div", null, views()));
    expect(markup).toContain('src="/remotion-public/assets/photo.png"');
    expect(markup).toContain('src="/remotion-public/assets/clip.mp4"');
    expect(vi.mocked(staticFile).mock.calls).toEqual([[image.src], [video.src]]);
  });

  it("resolves nested paths once and scopes the base without leaking to sibling providers", () => {
    const nested = { ...image, src: "assets/nested/photo.png" };
    const markup = renderToStaticMarkup(createElement("div", null,
      createElement(MediaAssetProvider, { mediaAssetBase: base, children: createElement(ImageSceneView, { scene: nested }) }),
      createElement(MediaAssetProvider, { children: createElement(VideoSceneView, { scene: video }) }),
    ));
    expect(markup).toContain('src="/remotion-public/assets/nested/photo.png"');
    expect(markup).toContain('src="/remotion-public/assets/clip.mp4"');
    expect(vi.mocked(staticFile).mock.calls).toEqual([[nested.src], [video.src]]);
  });

  it("wraps GlintVideo scenes once while leaving narration/music resolution and project identities unchanged", () => {
    const project = parseProject({ schemaVersion: 1, id: "media", title: "Media", aspect: "16:9", knowledgeSources: [],
      scenes: [{ ...image, narration: { ...image.narration, audioRef: "audio/voice.wav" } }, video],
      music: { src: "audio/music.wav" },
    });
    const snapshot = JSON.stringify(project);
    const web = renderToStaticMarkup(createElement(GlintVideo, { project, mediaAssetBase: base }));
    expect(web).toContain('src="/api/media/assets/photo.png"');
    expect(web).toContain('src="/api/media/assets/clip.mp4"');
    expect(web).toContain('src="/remotion-public/audio/voice.wav"');
    expect(web).toContain('src="/remotion-public/audio/music.wav"');
    expect(vi.mocked(staticFile).mock.calls.map(call => call[0]).sort()).toEqual(["audio/music.wav", "audio/voice.wav"]);
    vi.mocked(staticFile).mockClear();
    const cli = renderToStaticMarkup(createElement(GlintVideo, { project }));
    expect(cli).toContain('src="/remotion-public/assets/photo.png"');
    expect(cli).toContain('src="/remotion-public/assets/clip.mp4"');
    expect(cli).not.toContain(base);
    expect(JSON.stringify(project)).toBe(snapshot);
  });
});
