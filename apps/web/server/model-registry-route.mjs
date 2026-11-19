import { REGISTRY_BYTES } from "../src/model-registry-data.ts";

/** Mount after the shared access/origin checks. Does not resolve or execute adapters. */
export function createModelRegistryRoute(store) {
  return async function handle(req, res, url, { readBody, sendJson }) {
    if (url.pathname !== "/api/settings/model-registry") return false;
    const controller = new AbortController();
    const stop = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.once("close", stop);
    try {
      if (url.search) throw Object.assign(new Error(), { code: "invalid" });
      if (req.method === "GET") sendJson(res, 200, await store.read());
      else if (req.method === "PUT") {
        const body = JSON.parse(
          await readBody(
            req,
            AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
            REGISTRY_BYTES + 256,
          ),
        );
        if (
          !body ||
          typeof body !== "object" ||
          Array.isArray(body) ||
          Object.keys(body).some((key) => !["registry", "baseDigest"].includes(key))
        )
          throw Object.assign(new Error(), { code: "invalid" });
        sendJson(res, 200, await store.replace(body.registry, body.baseDigest));
      } else sendJson(res, 405, { code: "method", error: "method" });
    } catch (error) {
      const code = [
        "invalid",
        "too-large",
        "secret",
        "reserved",
        "conflict",
        "busy",
        "unsafe-path",
        "stored-invalid",
      ].includes(error.code)
        ? error.code
        : "storage";
      sendJson(res, error.status ?? (code === "storage" ? 500 : 400), { code, error: code });
    } finally {
      res.off("close", stop);
    }
    return true;
  };
}
