import fs from "node:fs";
import path from "node:path";

const REQUEST_LOG_MAX_BYTES = 5 * 1024 * 1024;

/** Fire-and-forget API journal; logging must never break or slow a request. */
export function logApiRequest(dir, entry) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "requests.log");
    try {
      if (fs.statSync(file).size > REQUEST_LOG_MAX_BYTES) fs.renameSync(file, `${file}.old`);
    } catch {
      /* first write or raced rotation */
    }
    fs.appendFile(file, JSON.stringify(entry) + "\n", () => {});
  } catch {
    /* logging must never break a request */
  }
}

export function sendJson(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(payload));
}

export function readBody(req, signal, maxBytes = 20_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    const cleanup = () => {
      req.off("data", data);
      req.off("end", end);
      req.off("error", fail);
      req.off("aborted", aborted);
      signal.removeEventListener("abort", aborted);
    };
    const fail = (error) => {
      cleanup();
      reject(error);
    };
    const aborted = () => fail(signal.reason ?? new Error("Request cancelled"));
    const data = (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        fail(Object.assign(new Error("Request body too large"), { status: 413 }));
        req.resume();
      } else chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    req.on("data", data);
    req.on("end", end);
    req.on("error", fail);
    req.on("aborted", aborted);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

export async function sendEvent(res, payload, signal) {
  signal.throwIfAborted();
  if (res.write(`data: ${JSON.stringify(payload)}\n\n`)) return;
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      res.off("drain", drain);
      res.off("error", fail);
      signal.removeEventListener("abort", aborted);
    };
    const drain = () => {
      cleanup();
      resolve();
    };
    const fail = (error) => {
      cleanup();
      reject(error);
    };
    const aborted = () => fail(signal.reason);
    res.once("drain", drain);
    res.once("error", fail);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}
