import { createHash, timingSafeEqual } from "node:crypto";
export function requestAccess(req, { publicHost, accessToken, authRequired = true } = {}) {
  if (publicHost && authRequired && (!accessToken || accessToken.length < 24)) throw new Error("Public hosting requires an access token of at least 24 characters");
  let host;
  try { host = new URL(`http://${req.headers.host}`).hostname; } catch { return { status: 403 }; }
  if (!["localhost", "127.0.0.1", "[::1]", publicHost].includes(host)) return { status: 403 };
  if (!publicHost || !authRequired) return { status: 200 };
  const header = req.headers.authorization ?? "";
  let value = "";
  if (header.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8"), split = decoded.indexOf(":");
    if (decoded.slice(0, split) === "glint") value = decoded.slice(split + 1);
  }
  const digest = text => createHash("sha256").update(text).digest();
  return { status: timingSafeEqual(digest(value), digest(accessToken)) ? 200 : 401 };
}
