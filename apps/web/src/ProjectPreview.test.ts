// @vitest-environment jsdom
import { act, createElement, forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTimeline, parseProject, timelineToFrames } from "@glintai/scenescript";
import type { CallbackListener, PlayerRef } from "@remotion/player";
import ProjectPreview, { type ProjectPreviewProps } from "./ProjectPreview";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
type MockProps = {
  initialFrame: number;
  durationInFrames: number;
  inputProps: { project: unknown; mediaAssetBase?: "/api/media/assets/" };
  controls: boolean;
  compositionWidth: number;
  compositionHeight: number;
  fps: number;
  style: { width: string; aspectRatio: string };
};
type MockPlayer = {
  props: MockProps;
  frame: number;
  listeners: Set<CallbackListener<"frameupdate">>;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  seekTo: ReturnType<typeof vi.fn>;
  emit(frame: number): void;
};
const players = vi.hoisted(() => ({ instances: [] as MockPlayer[], mounts: 0, unmounts: 0 }));
vi.mock("@glintai/video", () => ({ GlintVideo: () => null }));
vi.mock("@remotion/player", () => ({
  Player: forwardRef<PlayerRef, MockProps>((props, ref) => {
    // Remotion validates this prop on every render, even though it only initializes state once.
    if (!Number.isInteger(props.initialFrame) || props.initialFrame < 0 || props.initialFrame >= props.durationInFrames) {
      throw new Error("initialFrame is out of bounds");
    }
    const instance = useRef<MockPlayer | null>(null);
    if (!instance.current) {
      const player: MockPlayer = {
        props, frame: props.initialFrame, listeners: new Set(),
        addEventListener: vi.fn((name: string, callback: CallbackListener<"frameupdate">) => {
          if (name === "frameupdate") player.listeners.add(callback);
        }),
        removeEventListener: vi.fn((name: string, callback: CallbackListener<"frameupdate">) => {
          if (name === "frameupdate") player.listeners.delete(callback);
        }),
        seekTo: vi.fn((frame: number) => player.emit(frame)),
        emit(frame) {
          player.frame = frame;
          for (const listener of player.listeners) listener({ detail: { frame } });
        },
      };
      instance.current = player;
      players.instances.push(player);
    }
    instance.current.props = props;
    const player = instance.current;
    useImperativeHandle(ref, () => ({
      seekTo: player.seekTo, getCurrentFrame: () => player.frame,
      addEventListener: player.addEventListener, removeEventListener: player.removeEventListener,
    }) as unknown as PlayerRef, [player]);
    useEffect(() => { players.mounts++; return () => { players.unmounts++; }; }, []);
    return createElement("div", { "data-player-frame": player.frame });
  }),
}));

const fixture = (durations = [1000, 2000, 1000], fps = 30, overlapMs = 0) => parseProject({
  schemaVersion: 1, id: "preview", title: "Preview", aspect: "16:9", fps, knowledgeSources: [],
  scenes: durations.map((durationMs, index) => ({
    id: ["one", "two", "three"][index], kind: "title", title: `Scene ${index + 1}`,
    narration: { text: "Narration", durationMs },
    ...(index === 1 && overlapMs ? { transition: { in: "fade", overlapMs } } : {}),
  })),
});
let dispose = () => {};
beforeEach(() => { players.instances = []; players.mounts = 0; players.unmounts = 0; });
afterEach(() => { dispose(); dispose = () => {}; document.body.innerHTML = ""; });
async function mount(props: ProjectPreviewProps) {
  const node = document.createElement("div"); document.body.appendChild(node);
  const root = createRoot(node);
  dispose = () => act(() => root.unmount());
  const render = async (next: ProjectPreviewProps) => { await act(async () => root.render(createElement(ProjectPreview, next))); };
  await render(props);
  return { player: players.instances[0]!, render };
}
const emit = async (player: MockPlayer, frame: number) => { await act(async () => player.emit(frame)); };

describe("persistent project preview playhead", () => {
  it("passes the library transport outside the project without rewriting portable media or audio paths", async () => {
    const project = parseProject({ ...fixture(), scenes: [
      { id: "image", kind: "image", src: "assets/photo.png", narration: { text: "Image", durationMs: 1000 } },
      { id: "video", kind: "video", src: "assets/clip.mp4", narration: { text: "Video", durationMs: 1000 } },
      { id: "nested", kind: "image", src: "assets/nested/local.png", narration: { text: "Local", durationMs: 1000, audioRef: "audio/voice.wav" } },
    ] });
    const snapshot = JSON.stringify(project);
    const { player, render } = await mount({ project });
    expect(player.props.inputProps).toEqual({ project, mediaAssetBase: "/api/media/assets/" });
    expect(JSON.stringify(player.props.inputProps.project)).toBe(snapshot);
    expect(JSON.stringify(project)).toBe(snapshot);
    await render({ project });
    expect(player.props.inputProps.mediaAssetBase).toBe("/api/media/assets/");
    expect(JSON.stringify(project)).toBe(snapshot);
    expect(players.mounts).toBe(1);
  });

  it("uses rational NTSC scene boundaries and export duration, preserving controls and aspect", async () => {
    const project = fixture([20_000_000, 1000], 29.97);
    const expected = timelineToFrames(buildTimeline(project), 29.97);
    const { player, render } = await mount({ project, selectedSceneId: "two" });
    expect(expected.entries[1]!.from).toBe(599401);
    expect(player.props.initialFrame).toBe(expected.entries[1]!.from);
    expect(player.props.durationInFrames).toBe(expected.durationInFrames);
    expect(player.props.durationInFrames).not.toBe(Math.round(buildTimeline(project).totalMs * 29.97 / 1000));
    expect(player.props).toMatchObject({ fps: 29.97, controls: true, compositionWidth: 1920, compositionHeight: 1080,
      style: { width: "100%", aspectRatio: "1920/1080" } });
    expect(player.seekTo).not.toHaveBeenCalled();
    await render({ project, selectedSceneId: "one" });
    await render({ project, selectedSceneId: "two" });
    expect(player.seekTo.mock.calls).toEqual([[0], [expected.entries[1]!.from]]);
  });

  it("seeks only on changed selection, retaining the same Player through project edits", async () => {
    const project = fixture();
    const { player, render } = await mount({ project, selectedSceneId: "one" });
    await emit(player, 17);
    await render({ project: { ...project, title: "Edited" }, selectedSceneId: "one" });
    expect(player.frame).toBe(17); expect(player.seekTo).not.toHaveBeenCalled();
    const retimed = fixture([2000, 2000, 1000]);
    await render({ project: retimed, selectedSceneId: "one" });
    expect(player.frame).toBe(17); expect(player.seekTo).not.toHaveBeenCalled();
    await render({ project: retimed, selectedSceneId: "two" });
    expect(player.seekTo.mock.calls).toEqual([[60]]);
    await emit(player, 80);
    await render({ project: fixture([3000, 2000, 1000]), selectedSceneId: "two" });
    expect(player.frame).toBe(80); expect(player.seekTo.mock.calls).toEqual([[60]]);
    await render({ project: retimed, selectedSceneId: "missing" });
    await render({ project: retimed });
    expect(player.seekTo.mock.calls).toEqual([[60]]);
    expect(players.mounts).toBe(1); expect(players.unmounts).toBe(0); expect(players.instances).toHaveLength(1);
    expect(player.props.inputProps.project).toEqual(retimed);
  });

  it("clamps a shortened duration to its final drawable frame without resetting or remounting", async () => {
    const onFrameChange = vi.fn();
    const { player, render } = await mount({ project: fixture(), selectedSceneId: "one", onFrameChange });
    await emit(player, 110);
    await render({ project: fixture([500, 500, 500]), selectedSceneId: "one", onFrameChange });
    expect(player.props.durationInFrames).toBe(45);
    expect(player.frame).toBe(44); expect(player.seekTo.mock.calls).toEqual([[44]]);
    expect(onFrameChange).toHaveBeenLastCalledWith(44);
    await render({ project: fixture([1000, 500, 500]), selectedSceneId: "one" });
    expect(player.frame).toBe(44); expect(player.seekTo.mock.calls).toEqual([[44]]);
    expect(players.mounts).toBe(1);
  });

  it("keeps the initial-frame prop valid when the timeline shrinks below a restored playhead", async () => {
    const { player, render } = await mount({ project: fixture(), initialFrame: 110 });
    await render({ project: fixture([1]), initialFrame: 110 });
    expect(player.props.durationInFrames).toBe(1);
    expect(player.props.initialFrame).toBe(0);
    expect(player.frame).toBe(0);
    expect(player.seekTo.mock.calls).toEqual([[0]]);
    expect(players.mounts).toBe(1);
  });

  it.each([
    [undefined, 30], [47.9, 47], [-10, 0], [99999, 119], [NaN, 0], [Infinity, 0],
  ])("bounds initialFrame %s once and prioritizes restoration over initial selection", async (initialFrame, expected) => {
    const project = fixture();
    const { player, render } = await mount({ project, selectedSceneId: "two", initialFrame });
    expect(player.props.initialFrame).toBe(expected); expect(player.frame).toBe(expected);
    await emit(player, 55);
    await render({ project, selectedSceneId: "two", initialFrame: 1 });
    expect(player.frame).toBe(55); expect(player.props.initialFrame).toBe(expected);
    expect(player.seekTo).not.toHaveBeenCalled();
  });

  it("reports every frame and scene crossings with inclusive starts, exclusive ends and last-started overlaps", async () => {
    const onFrameChange = vi.fn(), onSceneChange = vi.fn();
    const { player } = await mount({ project: fixture([1000, 2000, 1000], 30, 400), selectedSceneId: "one", onFrameChange, onSceneChange });
    for (const frame of [0, 17, 18, 19, 77, 78, 107, 108, 0]) await emit(player, frame);
    expect(onFrameChange.mock.calls.map(([frame]) => frame)).toEqual([0, 17, 18, 19, 77, 78, 107, 108, 0]);
    expect(onSceneChange.mock.calls.map(([id]) => id)).toEqual(["two", "three"]);
    expect(player.seekTo).not.toHaveBeenCalled();
  });

  it("does not rewind when the parent echoes playback scene changes, but honors later user selections", async () => {
    const node = document.createElement("div"); document.body.appendChild(node);
    const root = createRoot(node); dispose = () => act(() => root.unmount());
    const onSceneChange = vi.fn();
    let select = (_id: string) => {};
    const project = fixture();
    function Harness() {
      const [selectedSceneId, setSelectedSceneId] = useState("one"); select = setSelectedSceneId;
      return createElement(ProjectPreview, { project, selectedSceneId,
        onSceneChange: id => { onSceneChange(id); setSelectedSceneId(id); } });
    }
    await act(async () => root.render(createElement(Harness)));
    const player = players.instances[0]!;
    await emit(player, 42); await emit(player, 43);
    expect(onSceneChange.mock.calls).toEqual([["two"]]);
    expect(player.frame).toBe(43); expect(player.seekTo).not.toHaveBeenCalled();
    await act(async () => select("one"));
    expect(player.seekTo.mock.calls).toEqual([[0]]);
    await act(async () => select("two"));
    expect(player.seekTo.mock.calls).toEqual([[0], [30]]);
  });

  it("uses latest callbacks and timeline without listener churn and detaches on unmount", async () => {
    const oldFrame = vi.fn(), oldScene = vi.fn(), newFrame = vi.fn(), newScene = vi.fn();
    const { player, render } = await mount({ project: fixture(), selectedSceneId: "one", onFrameChange: oldFrame, onSceneChange: oldScene });
    await render({ project: fixture([2000, 1000, 1000]), selectedSceneId: "one", onFrameChange: newFrame, onSceneChange: newScene });
    await emit(player, 40); // Still scene one on the latest timeline.
    expect(newFrame).toHaveBeenCalledWith(40); expect(newScene).not.toHaveBeenCalled();
    await emit(player, 60);
    expect(newScene).toHaveBeenCalledWith("two");
    expect(oldFrame).not.toHaveBeenCalled(); expect(oldScene).not.toHaveBeenCalled();
    expect(player.addEventListener).toHaveBeenCalledTimes(1);
    expect(player.addEventListener.mock.calls[0]![0]).toBe("frameupdate");
    dispose(); dispose = () => {};
    expect(player.removeEventListener.mock.calls).toEqual(player.addEventListener.mock.calls);
    expect(player.listeners.size).toBe(0);
    await emit(player, 99);
    expect(newFrame).toHaveBeenCalledTimes(2); expect(newScene).toHaveBeenCalledTimes(1);
  });
});
