// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { VoiceReview } from "./VoiceReview";
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let cleanup = () => {};
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it("keeps candidate identity hidden and never supplies automatic listener scores", async () => {
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:test") });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  const node = document.createElement("div"); document.body.appendChild(node);
  const root = createRoot(node); cleanup = () => { act(() => root.unmount()); node.remove(); };
  await act(async () => root.render(createElement(VoiceReview, { cardStyle: {} })));
  const input = node.querySelector('input[aria-label="候选配音"]')!;
  Object.defineProperty(input, "files", { value: [new File([new Uint8Array(100)], "secret-model-name.wav", { type: "audio/wav" })] });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
  expect(node.textContent).toContain("候选 A");
  expect(node.textContent).not.toContain("secret-model-name.wav");
  expect([...node.querySelectorAll("select")].every(select => select.value === "0")).toBe(true);
  expect([...node.querySelectorAll("button")].filter(button => button.disabled)).toHaveLength(2);
});
