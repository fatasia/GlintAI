// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { GenerationSurface } from "./GenerationSurface";

const capture = vi.hoisted(() => ({ props: null as any }));
vi.mock("@xyflow/react", () => ({
  ReactFlow: (props: unknown) => { capture.props = props; return null; },
  Background: () => null, Controls: () => null, MiniMap: () => null,
  applyNodeChanges: (_changes: unknown, nodes: unknown) => nodes,
}));
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

it.each(["foreign", "malformed"])("preserves %s viewport data on navigation", async mode => {
  const key = `glint:project-board:viewport:v1:${mode}`;
  const initial = mode === "malformed" ? "broken" : JSON.stringify({x:0,y:0,zoom:1});
  localStorage.setItem(key,initial);
  const element = document.createElement("div"); document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async()=>root.render(createElement(GenerationSurface,{viewportKey:key,items:[],edges:[],onMove:()=>{},onCreate:()=>{}})));
    if (mode === "foreign") {
      await act(async()=>capture.props.onMoveEnd(null,{x:10,y:20,zoom:1.2}));
      expect(JSON.parse(localStorage.getItem(key)!)).toEqual({x:10,y:20,zoom:1.2});
      localStorage.setItem(key,JSON.stringify({x:200,y:300,zoom:0.5}));
    }
    const preserved = localStorage.getItem(key);
    await act(async()=>capture.props.onMoveEnd(null,{x:90,y:80,zoom:2}));
    expect(localStorage.getItem(key)).toBe(preserved);
    expect(element.querySelector('[role="alert"]')?.textContent).toContain(mode === "foreign" ? "其他窗口" : "无法读取");
  } finally { await act(async()=>root.unmount()); element.remove(); localStorage.removeItem(key); }
});
