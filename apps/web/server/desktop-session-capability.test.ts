import { expect, it } from "vitest";
import { createDesktopSessionRegistry } from "./desktop-session-capability.mjs";

it("accepts only issued live credentials and never treats their text as identity", () => {
  let clock = 0;
  const registry = createDesktopSessionRegistry({ now: () => clock });
  const token = registry.issue(10);
  const request = (authorization: unknown) => ({ headers: { authorization } });
  const identity = registry.resolve(request(`Bearer ${token}`));
  expect(identity).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(identity).not.toBe(token);
  for (const value of [undefined, "Bearer fake", token, `Basic ${token}`, `Bearer ${token} `, `Bearer ${token},Bearer ${token}`]) expect(registry.resolve(request(value))).toBeUndefined();
  expect(registry.isActive(identity)).toBe(true);
  clock = 10;
  expect(registry.resolve(request(`Bearer ${token}`))).toBeUndefined();
  expect(registry.isActive(identity)).toBe(false);
  const second = registry.issue(10), id = registry.resolve(request(`Bearer ${second}`));
  registry.revoke(second);
  expect(registry.isActive(id)).toBe(false);
  const third = registry.issue(10);
  registry.close();
  expect(registry.resolve(request(`Bearer ${third}`))).toBeUndefined();
  expect(() => registry.issue(10)).toThrow(/closed/);
});

it("bounds lifetime and session count without evicting live sessions", () => {
  const registry = createDesktopSessionRegistry({ now: () => 0 });
  for (const duration of [0, -1, Infinity, 8 * 60 * 60_000 + 1]) expect(() => registry.issue(duration)).toThrow();
  const tokens = Array.from({ length: 64 }, () => registry.issue(100));
  expect(new Set(tokens).size).toBe(64);
  expect(() => registry.issue(100)).toThrow(/limit/);
  expect(registry.resolve({ headers: { authorization: `Bearer ${tokens[0]}` } })).toBeTruthy();
  registry.revoke(tokens[0]);
  expect(registry.issue(100)).toBeTruthy();
});
