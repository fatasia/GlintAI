import { afterEach, expect, it, vi } from "vitest";
import * as knowledge from "@glintai/knowledge";
import { CloudProviderHttp, downloadCloudOutput } from "./cloud-provider-http";
afterEach(() => vi.restoreAllMocks());
it("pins vendor origins and auth schemes and refuses redirect response URLs", async () => {
  const transport = vi.fn(async () => Response.json({ ok: true }));
  await new CloudProviderHttp("fal", "fixture-secret", transport).request("/owner/model", "POST", { prompt: "x" });
  expect(transport.mock.calls[0]).toMatchObject(["https://queue.fal.run/owner/model", { headers: { authorization: "Key fixture-secret" }, redirect: "error", body: '{"prompt":"x"}' }]);
  await expect(new CloudProviderHttp("replicate", "fixture-secret", transport).request("https://evil.test/", "GET")).rejects.toThrow("invalid-api-route");
  const redirect = vi.fn(async () => new Response("", { status: 302, headers: { location: "https://evil.test" } }));
  await expect(new CloudProviderHttp("fal", "fixture-secret", redirect).request("/owner/model", "GET")).rejects.toThrow("redirect-refused");
  expect(redirect).toHaveBeenCalledTimes(1);
});
it("bounds requests and response streams and redacts vendor bodies/transport failures", async () => {
  const secret = "credential-fixture";
  const network = vi.fn(async () => new Response(secret, { status: 401 }));
  const client = new CloudProviderHttp("replicate", secret, network);
  await expect(client.request("/v1/predictions", "POST", { input: "x".repeat(2 * 1024 * 1024) })).rejects.toThrow("request-too-large"); expect(network).not.toHaveBeenCalled();
  await expect(client.request("/v1/predictions/id", "GET")).rejects.toThrow("replicate: http-error (HTTP 401)");
  const huge = new CloudProviderHttp("fal", secret, async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)); controller.close(); } })));
  await expect(huge.request("/owner/model", "GET")).rejects.toThrow("response-too-large");
  const lost = new CloudProviderHttp("fal", secret, async () => { throw new Error(secret); });
  await expect(lost.request("/owner/model", "POST", {})).rejects.toThrow("fal: transport-or-response-error");
});
it("honors abort and bounded timeout without request retries", async () => {
  const network = vi.fn(async (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => { init.signal!.addEventListener("abort", () => reject(new Error("private details")), { once: true }); }));
  await expect(new CloudProviderHttp("fal", "fixture", network).request("/owner/model", "GET", undefined, { timeoutMs: 10 })).rejects.toThrow("aborted"); expect(network).toHaveBeenCalledTimes(1);
  const controller = new AbortController(); controller.abort();
  await expect(new CloudProviderHttp("fal", "fixture", network).request("/owner/model", "GET", undefined, { signal: controller.signal })).rejects.toThrow("aborted"); expect(network).toHaveBeenCalledTimes(1);
});
it("reuses the public HTTPS boundary without API headers or credentials", async () => {
  await expect(downloadCloudOutput("https://127.0.0.1/private")).rejects.toThrow("Private");
  const fetchAsset = vi.spyOn(knowledge, "fetchPublicAsset").mockResolvedValue({ bytes: Buffer.from("image"), contentType: "image/png" });
  const signal = AbortSignal.timeout(1000); expect((await downloadCloudOutput("https://cdn.example.test/result.png", signal)).bytes.toString()).toBe("image");
  expect(fetchAsset).toHaveBeenCalledWith("https://cdn.example.test/result.png", signal, 0, true);
});
