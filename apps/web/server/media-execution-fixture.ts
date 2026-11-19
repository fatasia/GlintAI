import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createMediaJobs } from "./media-jobs.mjs";
import { createMediaSettings } from "./media-settings.mjs";
import { createModelRegistryStore } from "./model-registry-store.mjs";
import { createMediaExecution } from "./media-execution.mjs";

export const pixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1cAAAAASUVORK5CYII=",
  "base64",
);
export function mediaModel(
  provider = "fal",
  pricing: object = { basis: "per-call", amountCny: 0.01 },
) {
  return {
    id: `test-${provider}`,
    name: `Test ${provider}`,
    provider,
    kind: "image",
    capabilities: ["text-to-image"],
    pricing,
    adapter: { type: provider, model: "owner/model" },
    source: "user",
  };
}
type VendorState = {
  calls: string[];
  submits: number;
  disconnect: boolean;
  downloadFailed: boolean;
  cancel: boolean;
};
function fixtureVendor(provider: string, state: VendorState) {
  return http.createServer(async (req, res) => {
    state.calls.push(`${req.method} ${req.url}`);
    for await (const chunk of req) {
      void chunk;
    }
    if (req.method === "POST" && !req.url?.endsWith("/cancel")) {
      state.submits++;
      if (state.disconnect) {
        req.socket.destroy();
        return;
      }
    }
    if (req.url?.startsWith("/object_info/")) {
      res.end(
        JSON.stringify({ EmptyLatentImage: { name: "EmptyLatentImage", input: {}, output: [] } }),
      );
      return;
    }
    if (req.url === "/pixel.png") {
      res.setHeader("content-type", "image/png");
      res.end(pixel);
      return;
    }
    res.setHeader("content-type", "application/json");
    let value: object = { request_id: "vendor-one" };
    if (provider === "fal") {
      if (req.url?.endsWith("/status")) value = { request_id: "vendor-one", status: "COMPLETED" };
      else if (req.url?.endsWith("/cancel")) value = { status: "OK" };
      else if (req.method === "GET")
        value = { images: [{ url: "https://output.example/pixel.png" }] };
    } else {
      if (req.url?.endsWith("/cancel")) state.cancel = true;
      value = {
        id: "vendor-one",
        status: state.cancel ? "canceled" : req.method === "POST" ? "starting" : "succeeded",
        output: ["https://output.example/pixel.png"],
      };
    }
    res.end(JSON.stringify(value));
  });
}
export async function executionFixture(provider = "fal") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "media-execution-"));
  const state: VendorState = {
    calls: [],
    submits: 0,
    disconnect: false,
    downloadFailed: false,
    cancel: false,
  };
  const server = fixtureVendor(provider, state);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const registry = createModelRegistryStore(path.join(root, "registry.json"));
  await registry.replace({ models: [mediaModel(provider)] }, (await registry.read()).digest);
  const jobs = createMediaJobs(root, {});
  const service = fixtureService(root, registry, jobs, origin, state);
  await service.accounts.save({ id: "account", provider, token: "fixture-credential" });
  await service.bindings.save({ id: "bound", modelId: `test-${provider}`, accountId: "account" });
  const input = {
    bindingId: "bound",
    type: "image",
    model: "owner/model",
    prompt: "A single blue square",
    params: {},
  };
  return {
    root,
    origin,
    registry,
    service,
    jobs,
    input,
    calls: state.calls,
    get submits() {
      return state.submits;
    },
    disconnect() {
      state.disconnect = true;
    },
    failDownload(value: boolean) {
      state.downloadFailed = value;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}
export async function approveFixture(
  fixture: Awaited<ReturnType<typeof executionFixture>>,
  requestId: string,
) {
  const quote = await fixture.service.quotes.quote(fixture.input);
  await fixture.service.quotes.approve({
    quoteId: quote.id,
    requestId,
    confirmed: true,
    capCny: 1,
  });
  return { ...fixture.input, quoteId: quote.id, requestId };
}

function fixtureService(
  root: string,
  registry: ReturnType<typeof createModelRegistryStore>,
  jobs: ReturnType<typeof createMediaJobs>,
  origin: string,
  state: VendorState,
) {
  return createMediaExecution({
    root,
    registryStore: registry,
    mediaSettings: createMediaSettings({ env: {} }),
    jobs,
    transport: async (url: string, init: RequestInit) => {
      const response = await fetch(origin + new URL(url).pathname, init);
      return new Response(response.body, { status: response.status, headers: response.headers });
    },
    download: async (_url: string, signal: AbortSignal) => {
      if (state.downloadFailed) throw new Error("fixture download disconnected");
      const response = await fetch(origin + "/pixel.png", { signal });
      return {
        bytes: Buffer.from(await response.arrayBuffer()),
        contentType: response.headers.get("content-type"),
      };
    },
  });
}
