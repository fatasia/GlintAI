import { createModelRegistryStore } from "./model-registry-store.mjs";
import { createModelRegistryRoute } from "./model-registry-route.mjs";
import { createTaskCenterReader } from "./task-center-read.mjs";

function llmRoute(settings, saved, tools) {
  return async (req, res, url) => {
    if (!url.pathname.startsWith("/api/settings/llm")) return false;
    const { readBody, sendJson } = tools;
    if (req.method === "GET" && url.pathname === "/api/settings/llm") {
      sendJson(res, 200, settings.read());
      return true;
    }
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "Method not allowed" });
      return true;
    }
    const controller = new AbortController();
    const stop = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.once("close", stop);
    try {
      const body = JSON.parse(await readBody(req, controller.signal, 8000));
      if (url.pathname.endsWith("/models"))
        sendJson(
          res,
          200,
          await settings.models(
            body,
            AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
          ),
        );
      else if (url.pathname.endsWith("/test"))
        sendJson(res, 200, await settings.test(controller.signal));
      else if (url.pathname !== "/api/settings/llm")
        sendJson(res, 404, { error: "Unknown settings endpoint" });
      else {
        const result = settings.save(body);
        saved();
        sendJson(res, 200, result);
      }
    } catch {
      if (!res.destroyed)
        sendJson(res, 400, {
          error:
            "Model configuration failed. Check address, key, model and protocol; enter a key again when changing services.",
        });
    } finally {
      res.off("close", stop);
    }
    return true;
  };
}

/** Called only after the host's access, base-path and write-origin checks. */
export function createWorkspaceFeatureRoutes({
  registryFile,
  registryStore,
  taskReader,
  mediaDir,
  renderStateDir,
  llmSettings,
  onLlmSaved,
  readBody,
  sendJson,
}) {
  const registry = createModelRegistryRoute(
    registryStore ?? createModelRegistryStore(registryFile),
  );
  const tasks = taskReader ?? createTaskCenterReader({ mediaDir, renderStateDir });
  const llm = llmRoute(llmSettings, onLlmSaved, { readBody, sendJson });
  return async (req, res, url) => {
    if (url.pathname === "/api/tasks") {
      if (req.method !== "GET") sendJson(res, 405, { error: "Method not allowed" });
      else {
        try {
          sendJson(res, 200, await tasks());
        } catch {
          sendJson(res, 500, { error: "Task records unavailable" });
        }
      }
      return true;
    }
    return (await registry(req, res, url, { readBody, sendJson })) || (await llm(req, res, url));
  };
}
