// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { DESIGN_ASSET_BYTES, DESIGN_LIBRARY_BYTES, fileToDataUrl, insertDesignImage, readLibrary, replaceDesignImage, urlToDataUrl } from "./design-assets";
import { DESIGN_HTML_LIMIT } from "./design-artifacts";

afterEach(() => vi.unstubAllGlobals());
const origin = () => vi.stubGlobal("location", { origin: "http://localhost:3000" });

const page = `<main><h1 data-design-id="title">标题</h1></main>`;

describe("design asset insertion", () => {
  it("appends an editable image block and returns its node id", () => {
    const result = insertDesignImage(page, "data:image/png;base64,AAAA", "产品图");
    expect(result.html).toContain(`data-design-id="${result.nodeId}"`);
    expect(result.html).toContain("data:image/png;base64,AAAA");
    expect(result.html).toContain('alt="产品图"');
    expect(result.html.indexOf(result.nodeId)).toBeGreaterThan(result.html.indexOf("title"));
  });

  it("replaces the picture behind the selected node without touching layout attributes", () => {
    const first = insertDesignImage(page, "data:image/png;base64,T0xE");
    const next = replaceDesignImage(first.html, first.nodeId, "data:image/png;base64,TkVX");
    expect(next).toContain("data:image/png;base64,TkVX");
    expect(next).not.toContain("data:image/png;base64,T0xE");
    expect(next).toContain("border-radius:12px");
  });

  it("refuses locked layers and unknown selections", () => {
    const locked = `<main><figure data-design-id="pic" data-design-locked="true"><img src="data:image/png;base64,T0xE"></figure></main>`;
    expect(() => replaceDesignImage(locked, "pic", "data:image/png;base64,TkVX")).toThrow(/锁定/);
    expect(() => replaceDesignImage(page, "missing", "data:image/png;base64,TkVX")).toThrow(/不存在/);
  });

  it("rejects unsupported formats and oversized files before reading them", async () => {
    await expect(fileToDataUrl(new File(["x"], "a.txt", { type: "text/plain" }))).rejects.toThrow(/只支持/);
    const big = new File([new Uint8Array(DESIGN_ASSET_BYTES + 1)], "big.png", { type: "image/png" });
    await expect(fileToDataUrl(big)).rejects.toThrow(/超过/);
  });

  it.each(["image/png", "image/jpeg", "image/webp", "image/gif"])("accepts the exact 512 KiB boundary for %s without exceeding page budget", async type => {
    const src = await fileToDataUrl(new File([new Uint8Array(DESIGN_ASSET_BYTES)], "image", { type }));
    const result = insertDesignImage(page, src);
    expect(new Blob([result.html]).size).toBeLessThan(DESIGN_HTML_LIMIT);
  });

  it("checks the complete serialized page after inserting and replacing", () => {
    const src = `data:image/png;base64,${"AAAA".repeat(180_000)}`;
    expect(() => insertDesignImage(page, src)).toThrow(/512/);
    const nearLimit = `<main>${"中".repeat(349_500)}</main>`;
    expect(() => insertDesignImage(nearLimit, "data:image/png;base64,AAAA")).toThrow(/1 MiB/);
    const first = insertDesignImage(page, "data:image/png;base64,AAAA");
    const full = first.html.replace("</main>", `${"a".repeat(400_000)}</main>`);
    const valid = `data:image/png;base64,${"AAAA".repeat(174_760)}`;
    expect(() => replaceDesignImage(full, first.nodeId, valid)).toThrow(/1 MiB/);
    expect(() => insertDesignImage(page, "https://evil.invalid/a.png")).toThrow(/内联图片/);
  });
});

describe("bounded library downloads", () => {
  it.each(["https://evil.invalid/api/media/assets/a.png", "//evil.invalid/a.png", "http://user:pass@localhost:3000/api/media/assets/a.png", "/api/media/assets/../a.png", "/api/media/assets/%61.png", "/api/media/assets/a.png?token=x", "/api/media/assets/a.png#x", "/api/media/assets/a.png\n", "javascript:alert(1)", "data:image/png;base64,AAAA", "/api/library/a.png", "/api/media/assets/a.gif", "/api/media/assets/a.jpeg"])("rejects untrusted or nonexistent route %s before fetch", async url => {
    origin(); const mock = vi.fn(); vi.stubGlobal("fetch", mock);
    await expect(urlToDataUrl(url)).rejects.toThrow(/同源/); expect(mock).not.toHaveBeenCalled();
  });

  it.each(["/api/media/assets/a.png", "/assets/a.png", "http://localhost:3000/api/media/assets/a.png"])("downloads only the canonical managed route %s", async url => {
    origin(); const mock = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png", "content-length": "3" } })); vi.stubGlobal("fetch", mock);
    expect(await urlToDataUrl(url)).toBe("data:image/png;base64,AQID");
    expect(mock).toHaveBeenCalledWith(new URL(url, "http://localhost:3000").pathname, expect.objectContaining({ redirect: "error", mode: "same-origin", credentials: "same-origin" }));
  });

  it("rejects oversized Content-Length without reading a single chunk", async () => {
    origin(); const read = vi.fn(), cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, headers: new Headers({ "content-type": "image/png", "content-length": String(DESIGN_ASSET_BYTES + 1) }), body: { cancel, getReader: read } }));
    await expect(urlToDataUrl("/api/media/assets/a.png")).rejects.toThrow(/超过/);
    expect(read).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([undefined, "3"])("cancels streams that exceed the limit despite Content-Length %s", async length => {
    origin(); const cancel = vi.fn(), releaseLock = vi.fn();
    const read = vi.fn().mockResolvedValueOnce({ value: new Uint8Array(DESIGN_ASSET_BYTES), done: false }).mockResolvedValueOnce({ value: new Uint8Array(1), done: false });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, headers: new Headers({ "content-type": "image/png", ...(length ? { "content-length": length } : {}) }), body: { getReader: () => ({ read, cancel, releaseLock }) } }));
    // cancel 与 releaseLock 只模拟流生命周期。
    cancel.mockResolvedValue(undefined);
    await expect(urlToDataUrl("/api/media/assets/a.png")).rejects.toThrow(/超过/);
    expect(read).toHaveBeenCalledTimes(2); expect(cancel).toHaveBeenCalledOnce(); expect(releaseLock).toHaveBeenCalledOnce();
  });

  it("rejects MIME mismatch, redirects, empty and truncated bodies", async () => {
    origin(); const mock = vi.fn(); vi.stubGlobal("fetch", mock);
    mock.mockResolvedValueOnce(new Response("x", { headers: { "content-type": "image/svg+xml" } }));
    await expect(urlToDataUrl("/api/media/assets/a.png")).rejects.toThrow(/格式/);
    mock.mockResolvedValueOnce({ ok: true, redirected: true, body: { cancel: vi.fn() } });
    await expect(urlToDataUrl("/api/media/assets/a.png")).rejects.toThrow(/读取失败/);
    mock.mockResolvedValueOnce(new Response("", { headers: { "content-type": "image/png" } }));
    await expect(urlToDataUrl("/api/media/assets/a.png")).rejects.toThrow(/为空/);
    mock.mockResolvedValueOnce(new Response("x", { headers: { "content-type": "image/png", "content-length": "2" } }));
    await expect(urlToDataUrl("/api/media/assets/a.png")).rejects.toThrow(/不一致/);
  });

  it("propagates abort and cancels its own reader", async () => {
    origin(); const controller = new AbortController(), cancel = vi.fn().mockResolvedValue(undefined), releaseLock = vi.fn();
    const read = vi.fn(async () => { controller.abort(); return { value: new Uint8Array(1), done: false }; });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, headers: new Headers({ "content-type": "image/png" }), body: { getReader: () => ({ read, cancel, releaseLock }) } }));
    await expect(urlToDataUrl("/api/media/assets/a.png", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(cancel).toHaveBeenCalled(); expect(releaseLock).toHaveBeenCalled();
  });

  it("bounds the JSON list and validates each library entry", async () => {
    origin(); const valid = { name: "a.png", url: "/api/media/assets/a.png", bytes: 100 };
    const mock = vi.fn().mockResolvedValue(Response.json({ assets: [valid, null, { ...valid, bytes: "1" }, { ...valid, bytes: DESIGN_ASSET_BYTES + 1 }, { ...valid, url: "/api/media/assets/b.png" }, { ...valid, url: "https://evil.invalid/a.png" }, { ...valid, bytes: -1 }] })); vi.stubGlobal("fetch", mock);
    expect(await readLibrary()).toEqual([valid]);
    mock.mockResolvedValueOnce(new Response("[]", { headers: { "content-type": "application/json", "content-length": String(DESIGN_LIBRARY_BYTES + 1) } }));
    await expect(readLibrary()).rejects.toThrow(/超过/);
    mock.mockResolvedValueOnce(Response.json(null)); await expect(readLibrary()).rejects.toThrow(/列表无效/);
    mock.mockResolvedValueOnce(Response.json({ assets: Array(5001).fill(valid) })); await expect(readLibrary()).rejects.toThrow(/5000/);
  });
});

it("large library images are opt-in and stay bounded to 8 MiB",async()=>{
 const asset={name:"large.png",url:"/api/media/assets/large.png",bytes:2*1024*1024};
 vi.stubGlobal("fetch",vi.fn(() => Promise.resolve(Response.json({assets:[asset,{...asset,name:"huge.png",url:"/api/media/assets/huge.png",bytes:8*1024*1024+1}]}))));
 expect(await readLibrary()).toEqual([]);expect(await readLibrary(undefined,true)).toEqual([asset]);
});

it.each(["declared", "streamed"])("optimized downloads reject an 8 MiB overflow (%s) before embedding", async mode => {
 origin(); const cancel = vi.fn().mockResolvedValue(undefined), releaseLock = vi.fn();
 const read = vi.fn().mockResolvedValueOnce({ value: new Uint8Array(8 * 1024 * 1024 + 1), done: false });
 vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true,
   headers: new Headers({ "content-type": "image/png", ...(mode === "declared" ? { "content-length": String(8 * 1024 * 1024 + 1) } : {}) }),
   body: { cancel, getReader: () => ({ read, cancel, releaseLock }) } }));
 await expect(urlToDataUrl("/api/media/assets/a.png", undefined, true)).rejects.toThrow(/超过/);
 expect(cancel).toHaveBeenCalledOnce();
 if (mode === "declared") expect(read).not.toHaveBeenCalled();
 else { expect(read).toHaveBeenCalledOnce(); expect(releaseLock).toHaveBeenCalledOnce(); }
});
