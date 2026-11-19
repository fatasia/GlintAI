/** Mounted after the host's authentication, Origin and base-path checks. */
export function createComfyMediaRoutes(jobs) {
  return async (req, res, url, { readBody, sendJson }) => {
    if (!url.pathname.startsWith("/api/media/comfyui/")) return false;
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]);
    const stop = () => { if (!res.writableEnded) controller.abort(); }; res.once("close", stop);
    const send = (status, value) => { if (!res.destroyed) sendJson(res, status, value); return true; };
    try {
      const route = url.pathname.slice("/api/media/comfyui/".length), adapter = jobs.comfyui;
      if (route === "config" && req.method === "GET") return send(200, adapter?.config() ?? { configured: false, endpoint: null, source: "none" });
      if (route === "config" && req.method === "POST") {
        if (!adapter) return send(503, { error: "Local workflow service is unavailable" });
        const body = JSON.parse(await readBody(req, signal, 1024)); signal.throwIfAborted();
        return send(200, adapter.configure(body));
      }
      if (!adapter?.configured()) return send(503, { error: "Local workflow service is not configured" });
      if (route === "validate" && req.method === "POST") {
        const body = JSON.parse(await readBody(req, signal, 3 * 1024 * 1024));
        return send(200, await adapter.validate(body, signal));
      }
      if (route === "submit" && req.method === "POST") {
        const body = JSON.parse(await readBody(req, signal, 3 * 1024 * 1024));
        return send(202, await adapter.submit(body, signal));
      }
      const match = /^(status|cancel|import)\/(comfy-[A-Za-z0-9_-]{1,64})$/.exec(route);
      if (!match) return send(404, { error: "Unknown local workflow action" });
      const [, action, taskId] = match;
      if (action === "status" && req.method === "GET") return send(200, await adapter.status(taskId, signal));
      if (req.method !== "POST" || action === "status") return send(405, { error: "Invalid local workflow method" });
      const raw = await readBody(req, signal, 1024), body = raw.trim() ? JSON.parse(raw) : {};
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => action !== "import" || key !== "outputIndex")) return send(400, { error: "Invalid local workflow fields" });
      return action === "cancel" ? send(200, await adapter.cancel(taskId, signal)) : send(200, await adapter.importOutput(taskId, body.outputIndex, signal));
    } catch (error) {
      if (error?.code === "missing-nodes") return send(422, { error: "Required local workflow nodes are missing", code: error.code, submitted: false, missing: error.missing.slice(0, 128), checked: error.checked });
      if (error?.code === "node-check-failed") return send(503, { error: "Local workflow node check failed; nothing was submitted", code: error.code, submitted: false });
      return send([400, 404, 409, 413, 422, 503].includes(error?.status) ? error.status : 400, { error: "Local workflow request refused; inspect the task before submitting again" });
    } finally { res.off("close", stop); }
  };
}
