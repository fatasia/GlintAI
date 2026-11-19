export async function handleMediaSettings(req, res, url, { settings, jobs, readBody, sendJson }) {
  if (url.pathname !== "/api/settings/media") return false;
  if (req.method === "GET") {
    sendJson(res, 200, settings.read());
    return true;
  }
  const controller = new AbortController();
  const stop = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.once("close", stop);
  try {
    if (req.method === "POST") {
      const saved = settings.save(JSON.parse(await readBody(req, controller.signal, 8192))),
        effective = settings.env();
      jobs.applyEnv?.({
        GLINT_MEDIA_BASE_URL: effective.baseUrl,
        GLINT_MEDIA_API_KEY: effective.apiKey,
        GLINT_MEDIA_PROTOCOL: effective.protocol,
      });
      sendJson(res, 200, saved);
    } else if (req.method === "DELETE") {
      const cleared = settings.clear();
      jobs.applyEnv?.({
        GLINT_MEDIA_BASE_URL: process.env.GLINT_MEDIA_BASE_URL,
        GLINT_MEDIA_API_KEY: process.env.GLINT_MEDIA_API_KEY,
        GLINT_MEDIA_PROTOCOL: process.env.GLINT_MEDIA_PROTOCOL ?? "skills",
      });
      sendJson(res, 200, cleared);
    } else sendJson(res, 405, { error: "Use GET, POST or DELETE" });
  } catch (error) {
    const unsafe = error instanceof SyntaxError || typeof error?.code === "string";
    sendJson(res, 400, {
      error: unsafe
        ? "Media settings were not saved; check the settings file and JSON"
        : error instanceof Error
          ? error.message
          : "Media settings were not saved",
    });
  } finally {
    res.off("close", stop);
  }
  return true;
}
