import { describe, expect, it } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import {
  createSilentWav,
  MockTtsProvider,
  OpenAICompatibleTtsProvider,
  parseWavDurationMs,
} from "./index";

describe("wav utilities", () => {
  it("round-trips duration through header creation and parsing", () => {
    const wav = createSilentWav(1234);
    expect(parseWavDurationMs(wav, -1)).toBe(1234);
    expect(wav.byteLength).toBe(44 + Math.ceil(1.234 * 24000) * 2);
  });

  it("falls back gracefully on non-wav bytes", () => {
    expect(parseWavDurationMs(new Uint8Array([1, 2, 3]), 777)).toBe(777);
  });

  it("rejects non-positive durations", () => {
    expect(() => createSilentWav(0)).toThrow(/positive/);
  });
});

describe("MockTtsProvider", () => {
  it("returns a silent wav with word timings aligned to duration", async () => {
    const provider = new MockTtsProvider();
    const result = await provider.synthesize({ text: "熵".repeat(46) });
    expect(result.durationMs).toBe(10000);
    expect(result.words.length).toBe(46);
    expect(
      result.words.reduce((max, word) => Math.max(max, word.endMs), 0),
    ).toBe(10000);
    expect(parseWavDurationMs(result.audio, -1)).toBe(10000);
  });

  it("rejects empty narration", async () => {
    await expect(
      new MockTtsProvider().synthesize({ text: "  " }),
    ).rejects.toThrow(/empty/);
  });
});

describe("OpenAICompatibleTtsProvider", () => {
  it("reads duration from the returned wav header", async () => {
    const wav = createSilentWav(2500);
    const server = http.createServer((req, res) => {
      if ((req.url ?? "").endsWith("/audio/speech") && req.method === "POST") {
        res.writeHead(200, { "content-type": "audio/wav" });
        res.end(Buffer.from(wav));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const provider = new OpenAICompatibleTtsProvider({
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        apiKey: "k",
        model: "tts-1",
      });
      const result = await provider.synthesize({
        text: "熵".repeat(25),
      });
      expect(result.durationMs).toBe(2500);
      expect(result.words[result.words.length - 1]?.endMs).toBe(2500);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it("surfaces provider errors as actionable TtsHttpError", async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(403);
      res.end("forbidden");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const provider = new OpenAICompatibleTtsProvider({
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        apiKey: "k",
        model: "tts-1",
      });
      await expect(provider.synthesize({ text: "熵" })).rejects.toThrow(
        /HTTP 403[\s\S]*Check your TTS baseUrl/,
      );
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});
