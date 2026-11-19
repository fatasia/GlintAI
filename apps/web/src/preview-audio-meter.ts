export const METER_FLOOR_DB = -60;
export type PreviewLevels = { left: number; right: number };

export interface PreviewAudioMeter {
  resume(): Promise<void>;
  attach(element: HTMLMediaElement, trackId?: string): void;
  setTrackEnabled(trackId: string, enabled: boolean): void;
  sampleTrack(trackId: string): number;
  retainTracks(trackIds: readonly string[]): void;
  retainElements(elements: readonly HTMLMediaElement[]): void;
  isActive(): boolean;
  sample(): PreviewLevels;
  close(): Promise<void>;
}

function rmsDb(samples: Float32Array): number {
  let energy = 0;
  for (const value of samples) energy += value * value;
  const rms = Math.sqrt(energy / samples.length);
  return rms > 0 ? Math.max(METER_FLOOR_DB, 20 * Math.log10(rms)) : METER_FLOOR_DB;
}

export function createPreviewAudioMeter(context: AudioContext): PreviewAudioMeter {
  const master = context.createGain();
  const splitter = context.createChannelSplitter(2);
  const left = context.createAnalyser(), right = context.createAnalyser();
  const silent = context.createGain();
  left.fftSize = right.fftSize = 512;
  silent.gain.value = 0;
  master.connect(context.destination);
  master.connect(splitter);
  splitter.connect(left, 0);
  splitter.connect(right, 1);
  // Analysers need a destination path, but the metering branch must not double the mix.
  left.connect(silent); right.connect(silent); silent.connect(context.destination);
  const leftSamples = new Float32Array(left.fftSize), rightSamples = new Float32Array(right.fftSize);
  type Group = { gain: GainNode; splitter: ChannelSplitterNode; left: AnalyserNode; right: AnalyserNode; leftSamples: Float32Array<ArrayBuffer>; rightSamples: Float32Array<ArrayBuffer> };
  const groups = new Map<string, Group>();
  const sources = new Map<HTMLMediaElement, { node: MediaElementAudioSourceNode; trackId: string | null }>();
  const groupFor = (trackId: string) => {
    let group = groups.get(trackId);
    if (group) return group;
    const gain = context.createGain(), splitter = context.createChannelSplitter(2), left = context.createAnalyser(), right = context.createAnalyser();
    left.fftSize = right.fftSize = 512;
    gain.connect(master); gain.connect(splitter); splitter.connect(left, 0); splitter.connect(right, 1);
    left.connect(silent); right.connect(silent);
    group = { gain, splitter, left, right, leftSamples: new Float32Array(left.fftSize), rightSamples: new Float32Array(right.fftSize) };
    groups.set(trackId, group); return group;
  };
  const disposeGroup = (group: Group) => { group.gain.disconnect(); group.splitter.disconnect(); group.left.disconnect(); group.right.disconnect(); };
  let closed = false;

  return {
    isActive() { return !closed && context.state === "running"; },
    async resume() {
      if (closed) throw new Error("音频计量已关闭，请重新打开剪辑台。");
      await context.resume();
    },
    attach(element, trackId = "__default") {
      // Capturing an element redirects its sound; never capture into a suspended graph.
      if (closed || context.state !== "running") return;
      let source = sources.get(element);
      if (source?.trackId === trackId) return;
      if (!source) { source = { node: context.createMediaElementSource(element), trackId: null }; sources.set(element, source); }
      else if (source.trackId !== null) source.node.disconnect();
      source.node.connect(groupFor(trackId).gain); source.trackId = trackId;
    },
    setTrackEnabled(trackId, enabled) { const group = groups.get(trackId); if (group) group.gain.gain.value = enabled ? 1 : 0; },
    sampleTrack(trackId) {
      const group = groups.get(trackId);
      if (!group || closed || context.state !== "running" || group.gain.gain.value === 0) return METER_FLOOR_DB;
      group.left.getFloatTimeDomainData(group.leftSamples); group.right.getFloatTimeDomainData(group.rightSamples);
      return Math.max(rmsDb(group.leftSamples), rmsDb(group.rightSamples));
    },
    retainTracks(trackIds) {
      const keep = new Set(trackIds);
      for (const source of sources.values()) if (source.trackId && !keep.has(source.trackId)) { source.node.disconnect(); source.trackId = null; }
      for (const [id, group] of groups) if (!keep.has(id)) { disposeGroup(group); groups.delete(id); }
    },
    retainElements(elements) {
      const keep = new Set(elements);
      for (const [element, source] of sources) if (!keep.has(element)) { source.node.disconnect(); sources.delete(element); }
    },
    sample() {
      if (closed || context.state !== "running") return { left: METER_FLOOR_DB, right: METER_FLOOR_DB };
      left.getFloatTimeDomainData(leftSamples); right.getFloatTimeDomainData(rightSamples);
      return { left: rmsDb(leftSamples), right: rmsDb(rightSamples) };
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const source of sources.values()) source.node.disconnect();
      sources.clear();
      for (const group of groups.values()) disposeGroup(group); groups.clear();
      master.disconnect(); splitter.disconnect(); left.disconnect(); right.disconnect(); silent.disconnect();
      await context.close();
    },
  };
}
