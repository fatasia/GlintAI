import { randomBytes } from "node:crypto";

const MAX_SESSIONS = 64;
const MAX_LIFETIME_MS = 8 * 60 * 60_000;

/** In-process capability registry. Issuance must only be called by a verified native
 * host; this module has no HTTP issuance endpoint and is not a same-user boundary. */
export function createDesktopSessionRegistry({ now = () => performance.now() } = {}) {
  const sessions = new Map();
  let closed = false;
  const prune = () => { const time = now(); for (const [token, session] of sessions) if (time >= session.expiresAt) sessions.delete(token); };
  const lookup = token => {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    const session = sessions.get(token);
    if (session && now() >= session.expiresAt) { sessions.delete(token); return undefined; }
    return session;
  };
  return {
    issue(lifetimeMs) {
      if (closed) throw new Error("Session registry closed");
      if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < 1 || lifetimeMs > MAX_LIFETIME_MS) throw new RangeError("Invalid session lifetime");
      prune();
      if (sessions.size >= MAX_SESSIONS) throw new Error("Session limit reached");
      const token = randomBytes(32).toString("base64url");
      sessions.set(token, { id: randomBytes(32).toString("base64url"), expiresAt: now() + lifetimeMs });
      return token;
    },
    resolve(req) {
      const header = req?.headers?.authorization;
      if (typeof header !== "string" || !header.startsWith("Bearer ")) return undefined;
      return lookup(header.slice(7))?.id;
    },
    isActive(id) {
      if (typeof id !== "string") return false;
      prune();
      for (const session of sessions.values()) if (session.id === id) return true;
      return false;
    },
    revoke(token) { sessions.delete(token); },
    close() { closed = true; sessions.clear(); },
  };
}
