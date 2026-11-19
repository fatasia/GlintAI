import { describe, expect, it, vi } from "vitest";
import { createPreviewAudioMeter, METER_FLOOR_DB } from "./preview-audio-meter";

function audioGraph(state: AudioContextState = "running") {
  const nodes: Array<{ connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = [];
  const node = () => { const value = { connect: vi.fn(), disconnect: vi.fn() }; nodes.push(value); return value; };
  const master = { ...node(), gain: { value: 1 } }, silent = { ...node(), gain: { value: 1 } };
  const splitter = node(), source = node();
  const groupGains: Array<{ connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; gain: { value: number } }> = [];
  const analyser = (sample: number) => ({ ...node(), fftSize: 512,
    getFloatTimeDomainData: vi.fn((buffer: Float32Array) => buffer.fill(sample)) });
  const left = analyser(0.5), right = analyser(0.25), destination = node();
  const context = { state, destination,
    createGain: vi.fn().mockReturnValueOnce(master).mockReturnValueOnce(silent).mockImplementation(() => { const gain = { ...node(), gain: { value: 1 } }; groupGains.push(gain); return gain; }),
    createChannelSplitter: vi.fn(() => splitter),
    createAnalyser: vi.fn().mockReturnValueOnce(left).mockReturnValueOnce(right).mockImplementation(() => analyser(0.5)),
    createMediaElementSource: vi.fn(() => source), resume: vi.fn(async () => { context.state = "running"; }),
    close: vi.fn(async () => { context.state = "closed"; }),
  };
  return { context, typed: context as unknown as AudioContext, master, silent, splitter, source, left, right, nodes, groupGains };
}

describe("preview stereo meter", () => {
  it("connects each captured media source into the audible bus exactly once", async () => {
    const graph = audioGraph(), meter = createPreviewAudioMeter(graph.typed);
    const element = {} as HTMLMediaElement;
    meter.attach(element); meter.attach(element);
    expect(graph.context.createMediaElementSource).toHaveBeenCalledTimes(1);
    expect(graph.source.connect).toHaveBeenCalledWith(graph.groupGains[0]);
    expect(graph.groupGains[0]!.connect).toHaveBeenCalledWith(graph.master);
    expect(graph.master.connect).toHaveBeenCalledWith(graph.context.destination);
    expect(graph.master.connect).not.toHaveBeenCalledWith(graph.source);
    expect(graph.silent.gain.value).toBe(0);
    await meter.close();
  });

  it("measures each channel independently without clipping values above full scale", async () => {
    const graph = audioGraph(), meter = createPreviewAudioMeter(graph.typed);
    const levels = meter.sample();
    expect(levels.left).toBeCloseTo(-6.02, 2);
    expect(levels.right).toBeCloseTo(-12.04, 2);
    graph.left.getFloatTimeDomainData.mockImplementation(buffer => buffer.fill(1.5));
    expect(meter.sample().left).toBeGreaterThan(0);
    graph.right.getFloatTimeDomainData.mockImplementation(buffer => buffer.fill(0));
    expect(meter.sample().right).toBe(METER_FLOOR_DB);
    await meter.close();
  });

  it("does not capture audio until the context is resumed", async () => {
    const graph = audioGraph("suspended"), meter = createPreviewAudioMeter(graph.typed);
    const element = {} as HTMLMediaElement;
    meter.attach(element);
    expect(graph.context.createMediaElementSource).not.toHaveBeenCalled();
    expect(meter.sample()).toEqual({ left: METER_FLOOR_DB, right: METER_FLOOR_DB });
    await meter.resume(); meter.attach(element);
    expect(graph.source.connect).toHaveBeenCalledWith(graph.groupGains[0]);
    await meter.close();
  });

  it("disconnects sources and closes the context once; late calls cannot reconnect", async () => {
    const graph = audioGraph(), meter = createPreviewAudioMeter(graph.typed);
    meter.attach({} as HTMLMediaElement);
    await meter.close(); await meter.close();
    expect(graph.context.close).toHaveBeenCalledTimes(1);
    expect(graph.source.disconnect).toHaveBeenCalledTimes(1);
    meter.attach({} as HTMLMediaElement);
    expect(graph.context.createMediaElementSource).toHaveBeenCalledTimes(1);
    expect(meter.sample().left).toBe(METER_FLOOR_DB);
    await expect(meter.resume()).rejects.toThrow("已关闭");
  });
  it("routes a media element by track, gates muted/solo tracks and frees removed groups", async () => {
    const graph = audioGraph(), meter = createPreviewAudioMeter(graph.typed), element = {} as HTMLMediaElement;
    meter.attach(element, "a"); expect(meter.sampleTrack("a")).toBeCloseTo(-6.02, 2);
    meter.setTrackEnabled("a", false); expect(graph.groupGains[0]!.gain.value).toBe(0); expect(meter.sampleTrack("a")).toBe(METER_FLOOR_DB);
    meter.setTrackEnabled("a", true); meter.attach(element, "b");
    expect(graph.context.createMediaElementSource).toHaveBeenCalledTimes(1); expect(graph.source.disconnect).toHaveBeenCalledTimes(1);
    expect(graph.source.connect).toHaveBeenLastCalledWith(graph.groupGains[1]);
    meter.retainTracks(["b"]); expect(graph.groupGains[0]!.disconnect).toHaveBeenCalledTimes(1); expect(meter.sampleTrack("a")).toBe(METER_FLOOR_DB);
    meter.retainTracks([]); expect(graph.source.disconnect).toHaveBeenCalledTimes(2);
    meter.attach(element, "b"); expect(graph.context.createMediaElementSource).toHaveBeenCalledTimes(1);
    meter.retainElements([]); expect(graph.source.disconnect).toHaveBeenCalledTimes(3);
    await meter.close();
  });
});
