export type ServiceOptions = { endpoint: string; token?: string; signal?: AbortSignal };
export class ServiceRequestError extends Error {
  constructor(
    public code: string,
    public status?: number,
  ) {
    super(`Service request ${code}`);
  }
}
const fail = (code: string): never => {
  throw new ServiceRequestError(code);
};
export function serviceTarget(endpoint: string, route: string): URL {
  if (!route.startsWith("/api/") || route.includes("..") || route.includes("?"))
    return fail("invalid-route");
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return fail("invalid-endpoint");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    return fail("invalid-endpoint");
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    return fail("insecure-endpoint");
  url.pathname = url.pathname.replace(/\/+$/, "") + route;
  return url;
}
function requestHeaders(token?: string): Record<string, string> {
  return {
    accept: "application/json",
    ...(token
      ? { authorization: `Basic ${Buffer.from(`glint:${token}`).toString("base64")}` }
      : {}),
  };
}
async function boundedJson(response: Response, limit: number): Promise<unknown> {
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    return fail("response-too-large");
  }
  if (!response.body) return fail("missing-response");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        return fail("response-too-large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return fail("invalid-response-json");
  }
}

export async function serviceJson(
  url: URL,
  options: ServiceOptions,
  init: { method: string; body?: string },
  limit: number,
) {
  const signal = AbortSignal.any([
    AbortSignal.timeout(30_000),
    ...(options.signal ? [options.signal] : []),
  ]);
  try {
    signal.throwIfAborted();
    const headers = requestHeaders(options.token);
    if (init.body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(url, { ...init, headers, redirect: "error", signal });
    const value = await boundedJson(response, limit);
    signal.throwIfAborted();
    return { value, ok: response.ok, status: response.status };
  } catch (error) {
    if (error instanceof ServiceRequestError) throw error;
    throw new ServiceRequestError(signal.aborted ? "aborted" : "transport-failed");
  }
}
