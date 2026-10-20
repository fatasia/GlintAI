import { lookup } from "node:dns/promises";
import { isIP, BlockList } from "node:net";
import http from "node:http";
import https from "node:https";

export const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const blocked = new BlockList();
for (const [ip, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.168.0.0", 16], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) blocked.addSubnet(ip, prefix, "ipv4");
for (const [ip, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]] as const) blocked.addSubnet(ip, prefix, "ipv6");

export function isPublicAddress(address: string): boolean {
  // IPv6 is deliberately conservative: only global unicast, no mapped IPv4.
  if (isIP(address) === 6) return /^[23][0-9a-f]{3}:/i.test(address) && !blocked.check(address, "ipv6");
  return isIP(address) === 4 && !blocked.check(address, "ipv4");
}

async function resolveHost(hostname: string, signal: AbortSignal) {
  let abort: () => void = () => {};
  try {
    return await Promise.race([
      lookup(hostname, { all: true }),
      new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export async function fetchSource(url: string, signal: AbortSignal, redirects = 0, httpsOnly = false, resolver = resolveHost): Promise<{ bytes: Buffer; contentType: string }> {
  signal.throwIfAborted();
  const parsed = new URL(url);
  if(httpsOnly && parsed.protocol !== "https:")throw new Error("HTTPS is required, including redirects");
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error("Source URL must be public HTTP(S), without credentials");
  if (redirects > 4) throw new Error("Too many source redirects");
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await resolver(hostname, signal);
  signal.throwIfAborted();
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) throw new Error("Private, loopback or reserved source URL is not allowed");
  const pinned = addresses[0]!;
  return new Promise((resolve, reject) => {
    const transport = parsed.protocol === "https:" ? https : http;
    const req = transport.get(parsed, {
      signal,
      // Pin the validated address to prevent DNS rebinding; preserve Host/TLS hostname.
      lookup: (_host, _options, callback) => callback(null, pinned.address, pinned.family),
      headers: { "accept-encoding": "identity" },
      family: pinned.family,
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0) && res.headers.location) {
        res.destroy();
        try {
          fetchSource(new URL(res.headers.location, parsed).href, signal, redirects + 1, httpsOnly, resolver).then(resolve, reject);
        } catch (error) { reject(error); }
        return;
      }
      if (res.statusCode !== 200) { res.destroy(); reject(new Error(`Source HTTP ${res.statusCode}`)); return; }
      if (res.headers["content-encoding"] && res.headers["content-encoding"] !== "identity") {
        res.destroy(); reject(new Error("Compressed source responses are not supported")); return;
      }
      if (Number(res.headers["content-length"]) > MAX_SOURCE_BYTES) { res.destroy(); reject(new Error("Source exceeds 10 MiB")); return; }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_SOURCE_BYTES) { res.destroy(new Error("Source exceeds 10 MiB")); return; }
        chunks.push(chunk);
      });
      res.on("error", reject);
      res.on("aborted", () => reject(new Error("Source response was interrupted")));
      res.on("end", () => resolve({ bytes: Buffer.concat(chunks), contentType: String(res.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase() }));
    });
    req.on("error", reject);
  });
}
