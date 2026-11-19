import { expect, it } from "vitest";
import { applicationUrl } from "./app-url";

it("adds the deployment prefix without changing stored URLs or double-prefixing requests", () => {
  for (const value of ["/api/session/list", "/api/media/assets/image.png?x=1", "/recipes/a.png", "/", "/sw.js"]) {
    const resolved = applicationUrl(value,"/glint/");
    expect(resolved).toBe(`/glint${value}`);
    expect(applicationUrl(resolved,"/glint/")).toBe(resolved);
    expect(applicationUrl(value,"/")).toBe(value);
  }
  expect(applicationUrl("/glint-other/a", "/glint/")).toBe("/glint/glint-other/a");
});
it("preserves external, blob, data, hash and relative URLs", () => {
  for (const value of ["https://example.com/api/a", "//example.com/a", "blob:123", "data:image/png;base64,abc", "#page-2", "assets/a.png"]) {
    expect(applicationUrl(value,"/glint/")).toBe(value);
  }
});
it("rejects ambiguous deployment prefixes", () => {
  for (const base of ["glint", "/glint", "//", "/../", "/a%2fb/", "/a?b/", "https://example.com/"])
    expect(()=>applicationUrl("/api/a",base)).toThrow("base path");
});
