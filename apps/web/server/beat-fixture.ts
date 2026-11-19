/** Tiny deterministic click track used only by beat-analysis tests. */
export function makeBeatFixture(silent = false, bpm = 120): Buffer {
  const rate = 22_050, duration = 8, frames = rate * duration, output = Buffer.alloc(44 + frames * 2);
  output.write("RIFF", 0); output.writeUInt32LE(output.length - 8, 4); output.write("WAVEfmt ", 8);
  output.writeUInt32LE(16, 16); output.writeUInt16LE(1, 20); output.writeUInt16LE(1, 22);
  output.writeUInt32LE(rate, 24); output.writeUInt32LE(rate * 2, 28); output.writeUInt16LE(2, 32); output.writeUInt16LE(16, 34);
  output.write("data", 36); output.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) {
    const period = 60_000 / bpm, timeMs = i * 1000 / rate, nearest = 200 + Math.round((timeMs - 200) / period) * period;
    const envelope = silent ? 0 : Math.max(0, 1 - Math.abs(timeMs - nearest) / 35);
    output.writeInt16LE(Math.round(28000 * envelope * Math.sin(2 * Math.PI * 440 * i / rate)), 44 + i * 2);
  }
  return output;
}
