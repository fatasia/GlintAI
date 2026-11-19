// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { StudioView } from "./routes";
import { useStudioRoute, type StudioLocation, type StudioRequest } from "./use-studio-route";
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let dispose = () => {};
afterEach(() => { dispose(); document.body.innerHTML = ""; vi.useRealTimers(); });

interface Harness {
  reports: StudioLocation[];
  setRequest(request: StudioRequest): void;
  setReady(ready: boolean): void;
  setView(view: StudioView): void;
  open: ReturnType<typeof vi.fn>;
}

async function mount(initial: { request?: StudioRequest; ready?: boolean; projectId?: string; known?: string[]; openSlowly?: boolean }): Promise<Harness> {
  const harness = { reports: [] as StudioLocation[] } as Harness;
  const known = new Set(initial.known ?? []);
  function Studio() {
    const [ready, setReady] = useState(initial.ready ?? true);
    const [request, setRequest] = useState(initial.request);
    const [view, setView] = useState<StudioView>("home");
    const [projectId, setProjectId] = useState(initial.projectId);
    harness.setRequest = setRequest; harness.setReady = setReady; harness.setView = setView;
    harness.open = harness.open ?? vi.fn((id: string) => {
      if (!known.has(id)) return false;
      const apply = () => { setProjectId(id); setView("workspace"); };
      if (initial.openSlowly) setTimeout(apply, 50); else apply();
      return true;
    });
    useStudioRoute({ ready, request, view, projectId, navigate: setView, openProject: harness.open, onLocationChange: location => harness.reports.push(location) });
    return null;
  }
  const node = document.createElement("div"); document.body.appendChild(node);
  const root = createRoot(node); dispose = () => act(() => root.unmount());
  await act(async () => { root.render(createElement(Studio)); });
  return harness;
}

it("opens a deep-linked project without reporting the boot-time home first", async () => {
  vi.useFakeTimers();
  const harness = await mount({ request: { view: "workspace", projectId: "p1", nonce: 1 }, known: ["p1"], openSlowly: true });
  expect(harness.reports).toEqual([]);
  await act(async () => { vi.advanceTimersByTime(60); });
  expect(harness.open).toHaveBeenCalledWith("p1");
  expect(harness.reports).toEqual([{ view: "workspace", projectId: "p1" }]);
});

it("waits for local restore before acting on a request", async () => {
  const harness = await mount({ ready: false, request: { view: "workspace", projectId: "p1", nonce: 1 }, known: ["p1"] });
  expect(harness.open).not.toHaveBeenCalled();
  expect(harness.reports).toEqual([]);
  await act(async () => { harness.setReady(true); });
  expect(harness.open).toHaveBeenCalledTimes(1);
  expect(harness.reports.at(-1)).toEqual({ view: "workspace", projectId: "p1" });
});

it("reports the real location when the project does not exist", async () => {
  const harness = await mount({ request: { view: "workspace", projectId: "missing", nonce: 1 } });
  expect(harness.open).toHaveBeenCalledWith("missing");
  expect(harness.reports.at(-1)).toEqual({ view: "home" });
});

it("settles to the real location when a guarded open is declined", async () => {
  vi.useFakeTimers();
  const harness = await mount({ request: { view: "workspace", projectId: "p1", nonce: 1 } });
  harness.open.mockImplementation(() => true);
  await act(async () => { harness.setRequest({ view: "workspace", projectId: "p2", nonce: 2 }); });
  const before = harness.reports.length;
  await act(async () => { vi.advanceTimersByTime(1600); });
  expect(harness.reports.length).toBe(before + 1);
  expect(harness.reports.at(-1)).toEqual({ view: "home" });
});

it("handles each request nonce once and reports user navigation", async () => {
  const harness = await mount({ request: { view: "plan", nonce: 1 } });
  expect(harness.reports.at(-1)).toEqual({ view: "plan" });
  await act(async () => { harness.setView("templates"); });
  expect(harness.reports.at(-1)).toEqual({ view: "templates" });
  await act(async () => { harness.setRequest({ view: "plan", nonce: 1 }); });
  expect(harness.reports.at(-1)).toEqual({ view: "templates" });
  await act(async () => { harness.setRequest({ view: "plan", nonce: 2 }); });
  expect(harness.reports.at(-1)).toEqual({ view: "plan" });
});

it("re-enters an already loaded project without reopening it", async () => {
  const harness = await mount({ projectId: "p1", request: { view: "workspace", projectId: "p1", nonce: 1 }, known: ["p1"] });
  expect(harness.open).not.toHaveBeenCalled();
  expect(harness.reports.at(-1)).toEqual({ view: "workspace", projectId: "p1" });
});
