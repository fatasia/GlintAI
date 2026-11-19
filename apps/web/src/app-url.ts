/** Stored project URLs stay portable; only browser requests acquire the mount path. */
export function applicationUrl<T extends string | null | undefined>(value: T, base: string = import.meta.env?.BASE_URL ?? "/"): T {
  if (!/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(base)) throw new Error("Invalid application base path");
  if (value == null || base === "/" || !value.startsWith("/") || value.startsWith("//")) return value;
  const prefix = base.slice(0, -1);
  return (value === prefix || value.startsWith(base) ? value : `${prefix}${value}`) as T;
}

/** Do not mutate global fetch: render workers and external provider URLs are separate. */
export function appFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(typeof input === "string" ? applicationUrl(input) : input, init);
}
