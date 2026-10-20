import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import http from "node:http";
import https from "node:https";
import { lookup } from "node:dns/promises";
import { fetchSource, isPublicAddress, MAX_SOURCE_BYTES } from "./source-url";
import { readSourceText } from "./source";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
const dns = vi.mocked(lookup);

afterEach(() => { vi.restoreAllMocks(); dns.mockReset(); });
it("requires HTTPS on catalog entry URLs and redirect hops",async()=>{
  await expect(fetchSource('http://public.example/a',new AbortController().signal,0,true)).rejects.toThrow('HTTPS');
  publicDns();respond(302,{location:'http://public.example/downgrade'});
  vi.spyOn(https,'get').mockImplementation(vi.mocked(http.get).getMockImplementation() as typeof https.get);
  await expect(readSourceText({url:'https://public.example/catalog.json'},{httpsOnly:true})).rejects.toThrow('HTTPS');
  expect(http.get).not.toHaveBeenCalled();
});

function respond(status: number, headers: Record<string, string>, chunks: Buffer[] = []) {
  const get = vi.spyOn(http, "get").mockImplementation(((_url: URL, _options: unknown, callback: (res: unknown) => void) => {
    const req = new EventEmitter();
    queueMicrotask(() => {
      const res = Object.assign(new PassThrough(), { statusCode: status, headers });
      callback(res);
      for (const chunk of chunks) res.write(chunk);
      res.end();
    });
    return req;
  }) as typeof http.get);
  return get;
}
function publicDns() { dns.mockResolvedValue([{ address: "8.8.8.8", family: 4 }] as never); }

describe("public URL source boundary (offline transports)", () => {
  it.each(["192.0.2.1", "198.51.100.1", "203.0.113.1", "2001:db8::1", "2001:0:1::1", "2001:20::1", "2002:7f00:1::", "3fff::1", "::ffff:8.8.8.8"])("blocks reserved/transition %s", (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });
  it("allows ordinary global IPv6", () => expect(isPublicAddress("2606:4700:4700::1111")).toBe(true));
  it("rejects a hostname when even one DNS answer is private", async () => {
    dns.mockResolvedValue([{ address: "8.8.8.8", family: 4 }, { address: "10.1.1.1", family: 4 }] as never);
    const get = vi.spyOn(http, "get");
    await expect(readSourceText({ url: "http://mixed.example" })).rejects.toThrow("Private");
    expect(get).not.toHaveBeenCalled();
  });
  it("pins the checked address and preserves the URL hostname", async () => {
    publicDns();
    const get = respond(200, { "content-type": " Text/Plain ; charset=utf-8" }, [Buffer.from("中文")]);
    expect(await readSourceText({ url: "http://public.example/doc" })).toBe("中文");
    expect(get.mock.calls[0]![0]).toEqual(new URL("http://public.example/doc"));
    const options = get.mock.calls[0]![1] as http.RequestOptions;
    const callback = vi.fn();
    (options.lookup as Function)("public.example", {}, callback);
    expect(callback).toHaveBeenCalledWith(null, "8.8.8.8", 4);
  });
  it("checks redirect destinations before connecting", async () => {
    publicDns();
    const get = respond(302, { location: "http://127.0.0.1/admin" });
    await expect(readSourceText({ url: "http://public.example" })).rejects.toThrow("Private");
    expect(get).toHaveBeenCalledTimes(1);
  });
  it("caps redirects including relative locations", async () => {
    publicDns();
    const get = respond(302, { location: "/again" });
    await expect(readSourceText({ url: "http://public.example" })).rejects.toThrow("redirects");
    expect(get).toHaveBeenCalledTimes(5);
  });
  it("rejects malformed redirect locations without uncaught exceptions", async () => {
    publicDns(); respond(302, { location: "http://[invalid" });
    await expect(readSourceText({ url: "http://public.example" })).rejects.toThrow();
  });
  it("rejects redirects to a non-HTTP protocol", async () => {
    publicDns(); respond(302, { location: "file:///secret" });
    await expect(readSourceText({ url: "http://public.example" })).rejects.toThrow("HTTP(S)");
  });
  it.each(["application/octet-stream", "image/png", ""])("does not guess an unsupported MIME %s from the file extension", async (mime) => {
    publicDns(); respond(200, { "content-type": mime }, [Buffer.from("plain-looking")]);
    await expect(readSourceText({ url: "http://public.example/doc.md" })).rejects.toThrow("Unsupported");
  });
  it("rejects oversized content-length", async () => {
    publicDns(); respond(200, { "content-length": String(MAX_SOURCE_BYTES + 1) });
    await expect(readSourceText({ url: "http://public.example" })).rejects.toThrow("10 MiB");
  });
  it("caps chunked bodies without trusting content-length", async () => {
    publicDns(); respond(200, { "content-type": "text/plain" }, [Buffer.alloc(MAX_SOURCE_BYTES), Buffer.from("x")]);
    await expect(readSourceText({ url: "http://public.example" })).rejects.toThrow("10 MiB");
  });
  it("rejects compressed responses even when the server ignores identity", async () => {
    publicDns(); respond(200, { "content-encoding": "gzip" });
    await expect(readSourceText({ url: "http://public.example" })).rejects.toThrow("Compressed");
  });
  it("reports HTTP failures", async () => {
    publicDns(); respond(503, {});
    await expect(readSourceText({ url: "http://public.example" })).rejects.toThrow("HTTP 503");
  });
  it.each([
    ["text/markdown", "# 标题\n内容", "标题"],
    ["text/html", "<h1>标题</h1><script>bad</script>", "标题"],
    ["application/json", '{"主题":"内容"}', '"主题"'],
    ["text/csv", "主题,内容\n标题,解释", "Columns:"],
  ])("extracts URL MIME %s", async (mime, body, expected) => {
    publicDns(); respond(200, { "content-type": mime }, [Buffer.from(body)]);
    expect(await readSourceText({ url: "http://public.example/download" })).toContain(expected);
  });
  it("cancels a stalled transport using the shared deadline", async () => {
    publicDns();
    vi.spyOn(http, "get").mockImplementation(((_url: URL, options: http.RequestOptions) => {
      const req = new EventEmitter();
      options.signal!.addEventListener("abort", () => req.emit("error", options.signal!.reason), { once: true });
      return req;
    }) as typeof http.get);
    await expect(readSourceText({ url: "http://public.example" }, { timeoutMs: 20 })).rejects.toThrow();
  });
  it("bounds stalled DNS and removes abort listeners", async () => {
    dns.mockImplementation(() => new Promise(() => {}) as never);
    await expect(readSourceText({ url: "http://public.example" }, { timeoutMs: 15 })).rejects.toThrow();
    publicDns(); respond(200, { "content-type": "text/plain" });
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    await fetchSource("http://public.example", controller.signal);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });
  it("reports interrupted bodies rather than resolving truncated text", async () => {
    publicDns();
    vi.spyOn(http, "get").mockImplementation(((_url: URL, _options: unknown, callback: (res: unknown) => void) => {
      queueMicrotask(() => {
        const res = Object.assign(new PassThrough(), { statusCode: 200, headers: {} });
        callback(res); res.emit("aborted"); res.destroy();
      });
      return new EventEmitter();
    }) as typeof http.get);
    await expect(readSourceText({ url: "http://public.example" })).rejects.toThrow("interrupted");
  });
});
