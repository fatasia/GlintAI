/** Mount after the common access, Origin and base-path checks.
 * `service` may be a factory, resolved on the first request that reaches an action. */
export function createMediaExecutionRoutes(serviceSource) {
  const service = () =>
    typeof serviceSource === "function" ? serviceSource() : serviceSource;
  return async (req, res, url, { readBody, sendJson }) => {
    if (!url.pathname.startsWith("/api/media/execution/")) return false;
    const controller = new AbortController(),
      signal = controller.signal;
    const stop = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.once("close", stop);
    const send = (status, value) => {
      if (!res.destroyed) sendJson(res, status, value);
      return true;
    };
    try {
      if (url.search) return send(400, { code: "invalid-query" });
      const action = url.pathname.slice("/api/media/execution/".length);
      const api = service();
      if (req.method === "GET") {
        if (action === "config") return send(200, await api.config());
        if (action === "bindings") return send(200, await api.bindings.list());
        const match = /^(receipt|request|status)\/([A-Za-z0-9_-]{1,100})$/.exec(action);
        if (match) {
          const value =
            match[1] === "receipt"
              ? await api.quotes.receipt(match[2])
              : match[1] === "request"
                ? await api.request(match[2])
                : await api.status(match[2], signal);
          return send(value ? 200 : 404, value ?? { code: "unknown-request" });
        }
      }
      if (req.method !== "POST") return send(405, { code: "invalid-method" });
      const body = JSON.parse(await readBody(req, signal, 3 * 1024 * 1024));
      signal.throwIfAborted();
      if (action === "accounts") return send(200, await api.accounts.save(body));
      if (action === "bindings") return send(200, await api.bindings.save(body));
      if (action === "quote") return send(200, await api.quotes.quote(body));
      if (action === "approve") return send(200, await api.quotes.approve(body));
      if (action === "submit") return send(202, await api.submit(body, signal));
      const cancel = /^cancel\/([A-Za-z0-9_-]{1,100})$/.exec(action);
      if (cancel) return send(200, await api.cancel(cancel[1], signal));
      const imported = /^import\/(comfy-[A-Za-z0-9_-]{1,64})$/.exec(action);
      if (imported) return send(200, await api.import(imported[1], body.outputIndex, signal));
      return send(404, { code: "unknown-action" });
    } catch (error) {
      const code = /^[a-z][a-z0-9-]{0,63}$/.test(error.code ?? "")
        ? error.code
        : "execution-refused";
      return send([400, 404, 409, 413, 422, 503].includes(error.status) ? error.status : 400, {
        code,
        error: code,
      });
    } finally {
      res.off("close", stop);
    }
  };
}
