import { describe, expect, it } from "vitest";
import { formatRoute, parseRoute, sameRoute, type AppRoute } from "./routes";

describe("app routes", () => {
  const canonical: AppRoute[] = [
    { area: "studio", view: "home" },
    { area: "studio", view: "plan" },
    { area: "studio", view: "templates" },
    { area: "studio", view: "workspace" },
    { area: "studio", view: "workspace", projectId: "idea-7f3a" },
    { area: "library", tab: "brand" },
    { area: "automation", tab: "batch" },
    { area: "automation", tab: "tasks" },
    { area: "edit" },
    { area: "container" },
    { area: "container", projectId: "work-1", objectId: "document-1" },
    { area: "settings" },
    { area: "docs", rest: "" },
    { area: "docs", rest: "nle/export" },
  ];

  it("round-trips every canonical route", () => {
    for (const route of canonical) expect(parseRoute(formatRoute(route))).toEqual(route);
  });

  it("accepts the raw hash with or without the leading #", () => {
    expect(parseRoute("#/tasks")).toEqual({ area: "automation", tab: "tasks" });
    expect(formatRoute(parseRoute("#/tasks"))).toBe("/automation/tasks");
    expect(parseRoute("#/tasks/unknown")).toEqual({ area: "studio", view: "home" });
    expect(parseRoute("#/c/work-1/document-1")).toEqual({ area: "container", projectId: "work-1", objectId: "document-1" });
    expect(parseRoute("#/p/abc")).toEqual({ area: "studio", view: "workspace", projectId: "abc" });
    expect(parseRoute("/p/abc")).toEqual(parseRoute("#/p/abc"));
    expect(parseRoute("")).toEqual({ area: "studio", view: "home" });
  });

  it("falls back instead of throwing on unknown or hostile input", () => {
    expect(parseRoute("/nope")).toEqual({ area: "studio", view: "home" });
    expect(parseRoute("/p/")).toEqual({ area: "studio", view: "home" });
    expect(parseRoute("/p/..%2F..%2Fetc")).toEqual({ area: "studio", view: "home" });
    expect(parseRoute("/p/%E0%A4%A")).toEqual({ area: "studio", view: "home" });
    expect(parseRoute("/c/../document")).toEqual({ area: "studio", view: "home" });
    expect(parseRoute("/c/valid/document/extra")).toEqual({ area: "studio", view: "home" });
    expect(parseRoute("/library/unknown")).toEqual({ area: "library", tab: "create" });
    expect(parseRoute("/automation")).toEqual({ area: "automation", tab: "canvas" });
  });

  it("ignores query strings so links can carry hints without changing the route", () => {
    expect(parseRoute("/settings?from=home")).toEqual({ area: "settings" });
  });

  it("encodes project ids and compares routes canonically", () => {
    expect(formatRoute({ area: "studio", view: "workspace", projectId: "a.b_c-1" })).toBe("/p/a.b_c-1");
    expect(sameRoute(parseRoute("/library"), { area: "library", tab: "create" })).toBe(true);
    expect(sameRoute(parseRoute("/p/a"), parseRoute("/p/b"))).toBe(false);
  });
});
