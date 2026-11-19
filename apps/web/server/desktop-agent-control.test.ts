import { expect, it, vi } from "vitest";
import { createDesktopAgentControl } from "./desktop-agent-control.mjs";

it("loads the agent host only after an explicit native request", async () => {
  const request = vi.fn(async value => ({ ok: true, ...value })), dispose = vi.fn();
  const createHost = vi.fn(() => ({ request, dispose }));
  const control = createDesktopAgentControl({ dataDir: "fixture", createHost });
  expect(createHost).not.toHaveBeenCalled();
  expect(await control.request({ action: "list" })).toEqual({ ok: true, action: "list" });
  await control.request({ action: "status", agentId: "codex" });
  expect(createHost).toHaveBeenCalledTimes(1);
  expect(createHost).toHaveBeenCalledWith({ dataDir: "fixture" });
  await control.dispose();
  expect(dispose).toHaveBeenCalledTimes(1);
  await expect(control.request({ action: "list" })).rejects.toThrow("关闭");
});

it("does not create agent files when the desktop closes without using an agent", async () => {
  const createHost = vi.fn();
  const control = createDesktopAgentControl({ dataDir: "unused", createHost });
  await control.dispose();
  expect(createHost).not.toHaveBeenCalled();
});
