// Hash routes are the single source of navigation state. The server has no SPA
// fallback and the desktop host only opens the bare origin, so every location
// lives after "#". Formatting is canonical: parse(format(route)) === route.

export const LIBRARY_TABS = ["create", "brand", "examples"] as const;
export const AUTOMATION_TABS = ["canvas", "skills", "batch", "tasks"] as const;
export type LibraryTab = (typeof LIBRARY_TABS)[number];
export type AutomationTab = (typeof AUTOMATION_TABS)[number];
export type StudioView = "home" | "plan" | "templates" | "workspace";

export type AppRoute =
  | { area: "studio"; view: Exclude<StudioView, "workspace"> }
  | { area: "studio"; view: "workspace"; projectId?: string }
  | { area: "library"; tab: LibraryTab }
  | { area: "automation"; tab: AutomationTab }
  | { area: "container"; projectId?: string; objectId?: string }
  | { area: "edit" }
  | { area: "settings" }
  | { area: "docs"; rest: string };

export const HOME_ROUTE: AppRoute = { area: "studio", view: "home" };
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function segments(location: string): string[] | null {
  const path = location.replace(/^#/, "").split("?")[0] ?? "";
  try {
    return path.split("/").filter(Boolean).map(part => decodeURIComponent(part));
  } catch {
    return null;
  }
}

function pick<T extends string>(value: string | undefined, allowed: readonly T[]): T {
  return (allowed as readonly string[]).includes(value ?? "") ? value as T : allowed[0]!;
}

export function parseRoute(location: string): AppRoute {
  const parts = segments(location);
  if (!parts) return HOME_ROUTE;
  const [head, second, ...rest] = parts;
  switch (head) {
    case undefined: return HOME_ROUTE;
    case "plan":
    case "templates":
      return { area: "studio", view: head };
    case "new":
      return { area: "studio", view: "workspace" };
    case "p":
      return second && PROJECT_ID.test(second)
        ? { area: "studio", view: "workspace", projectId: second }
        : HOME_ROUTE;
    case "library":
      return { area: "library", tab: pick(second, LIBRARY_TABS) };
    case "automation":
      return { area: "automation", tab: pick(second, AUTOMATION_TABS) };
    case "tasks":
      return parts.length === 1 ? { area: "automation", tab: "tasks" } : HOME_ROUTE;
    case "c":
      return (!second || /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(second)) &&
        rest.length <= 1 &&
        (!rest[0] || /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(rest[0]))
        ? {
            area: "container",
            ...(second ? { projectId: second } : {}),
            ...(rest[0] ? { objectId: rest[0] } : {}),
          }
        : HOME_ROUTE;
    case "edit":
      return { area: "edit" };
    case "settings":
      return { area: "settings" };
    case "docs":
      return { area: "docs", rest: [second, ...rest].filter(Boolean).join("/") };
    default:
      return HOME_ROUTE;
  }
}

export function formatRoute(route: AppRoute): string {
  switch (route.area) {
    case "studio":
      if (route.view === "workspace") return route.projectId ? `/p/${encodeURIComponent(route.projectId)}` : "/new";
      return route.view === "home" ? "/" : `/${route.view}`;
    case "library": return `/library/${route.tab}`;
    case "automation": return `/automation/${route.tab}`;
    case "container": return `/c${route.projectId ? `/${encodeURIComponent(route.projectId)}${route.objectId ? `/${encodeURIComponent(route.objectId)}` : ""}` : ""}`;
    case "edit": return "/edit";
    case "settings": return "/settings";
    case "docs": return route.rest ? `/docs/${route.rest}` : "/docs";
  }
}

export function sameRoute(a: AppRoute, b: AppRoute): boolean {
  return formatRoute(a) === formatRoute(b);
}

export type RailArea = "studio" | "library" | "automation" | "edit" | "settings";
export function railArea(route: AppRoute): RailArea | undefined {
  return route.area === "docs" ? undefined : route.area === "container" ? "studio" : route.area;
}
