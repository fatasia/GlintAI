// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { NleEditor } from "./NleEditor";

it("keeps shared status outside the existing three-row editor grid", () => {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(createElement(NleEditor, { shared: { projectId: "work", objectId: "timeline" } }));
  const editor = host.querySelector('.nle-editor')!;
  expect(editor).not.toBeNull();
  const status = host.querySelector('[aria-label="共享时间线 · r0"]')!;
  expect(status).not.toBeNull(); expect(status.parentElement).toBe(host);
  expect(status.nextElementSibling).toBe(editor);
  expect([...editor.children].slice(0, 3).map(item => item.className)).toEqual(["nle-bar", "nle-body", "timeline-dock"]);
  const timeline = editor.children[2]!.querySelector(".nle-timeline")!;
  expect(timeline).not.toBeNull(); expect(timeline.getAttribute("aria-label")).toBe("多轨时间线");
  expect(editor.children[2]!.querySelector(".timeline-dock__body")!.contains(timeline)).toBe(true);
});
