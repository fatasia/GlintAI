// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { registerAuthoringLeaveGuard } from "./authoring-leave";
import { guardWorkspaceViewChange } from "./SceneTimelineDock";

let release = () => {};
afterEach(() => {
  release();
  document.body.innerHTML = "";
});

function click(pressed?: string) {
  const button = document.createElement("button");
  if (pressed) button.setAttribute("aria-pressed", pressed);
  const inner = document.createElement("span");
  button.append(inner);
  document.body.append(button);
  return { target: inner, preventDefault: vi.fn(), stopPropagation: vi.fn() };
}

it("prevents navigation and reports the original draft guard without disposing it", () => {
  const check = vi.fn(() => {
    throw new Error("geometry draft pending");
  });
  release = registerAuthoringLeaveGuard("previz", check);
  const event = click("false"),
    notify = vi.fn();
  expect(guardWorkspaceViewChange(event, notify, true)).toBe(false);
  expect(event.preventDefault).toHaveBeenCalledTimes(1);
  expect(event.stopPropagation).toHaveBeenCalledTimes(1);
  expect(notify).toHaveBeenCalledWith("geometry draft pending");
  expect(guardWorkspaceViewChange(click(), notify)).toBe(false);
  expect(check).toHaveBeenCalledTimes(2);
});

it("keeps the current view clickable and permits navigation after draft resolution", () => {
  const check = vi.fn(() => {
    throw new Error("pending");
  });
  release = registerAuthoringLeaveGuard("previz", check);
  expect(guardWorkspaceViewChange(click("true"), vi.fn(), true)).toBe(true);
  expect(check).not.toHaveBeenCalled();
  release();
  const event = click("false"),
    notify = vi.fn();
  expect(guardWorkspaceViewChange(event, notify, true)).toBe(true);
  expect(event.preventDefault).not.toHaveBeenCalled();
  expect(notify).not.toHaveBeenCalled();
});
