import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import { taskRequest } from "./task-api-client";
import { taskTools } from "./task-mcp";
import { runTasks } from "./task-cli";
import { createMcpHandler } from "./mcp";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const token = "fixture-task-access-token-only";
let server: Server | undefined;
const calls: string[] = [];
const row = (family = "media", id = "task-one") => ({
  family,
  id,
  state: "running",
  isFinal: false,
  createdAt: null,
  cost: { amount: null, unit: null },
  prompt: "private-prompt",
  url: "https://private.invalid/result",
});
async function start(
  override?: (route: string) => { status?: number; value?: unknown; redirect?: string },
) {
  calls.length = 0;
  server = createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    const route = req.url!;
    const response =
      req.headers.authorization !== `Basic ${Buffer.from(`glint:${token}`).toString("base64")}`
        ? { status: 401, value: { error: "private-error" } }
        : override?.(route);
    res.writeHead(response?.status ?? 200, {
      "content-type": "application/json",
      ...(response?.redirect ? { location: response.redirect } : {}),
    });
    res.end(
      JSON.stringify(
        response?.value ??
          (route === "/mount/api/tasks"
            ? {
                tasks: [row(), row("comfyui", "comfy-one"), row("render", "idea-one")],
                truncated: false,
                unreadable: 0,
              }
            : route.includes("cancel/comfy")
              ? { taskId: "comfy-one", outcome: "not-queued" }
              : route.includes("cancel/")
                ? { taskId: "task-one", state: "cancelled", isFinal: true }
                : route.includes("make/")
                  ? req.method === "DELETE"
                    ? { cancelled: true }
                    : { id: "idea-one", status: "done" }
                  : {
                      taskId: "task-one",
                      state: "success",
                      isFinal: true,
                      cost: 3,
                      assetUrl: "https://private.invalid/result",
                      prompt: "private-prompt",
                    }),
      ),
    );
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return { endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mount`, token };
}
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

it("uses authenticated HTTP metadata and status only, without prompts, URLs or cost guesses", async () => {
  const options = await start();
  await expect(taskRequest("list", {}, { ...options, token: "wrong" })).rejects.toMatchObject({
    code: "http-refused",
    status: 401,
  });
  const list = await taskRequest("list", {}, options);
  expect(JSON.stringify(list)).not.toMatch(/private|prompt|https:/);
  expect(list).toMatchObject({ tasks: [{ cost: { amount: null, unit: null } }, {}, {}] });
  const status = await taskRequest("status", { family: "media", id: "task-one" }, options);
  expect(status).toMatchObject({ state: "success", cost: { amount: 3, unit: null } });
  expect(JSON.stringify(status)).not.toMatch(/private|prompt|https:/);
  expect(calls.every((call) => call.startsWith("GET "))).toBe(true);
  await expect(
    taskRequest("status", { family: "media", id: "reserved" }, options),
  ).rejects.toMatchObject({ code: "task-not-listed-use-original-entry" });
  expect(calls.some((call) => call.includes("status/reserved"))).toBe(false);
});

it("requires confirmation before any request and preserves each cancellation outcome", async () => {
  const options = await start();
  await expect(
    taskRequest("cancel", { family: "media", id: "task-one" }, options),
  ).rejects.toMatchObject({ code: "confirmation-required" });
  expect(calls).toEqual([]);
  expect(
    await taskRequest("cancel", { family: "media", id: "task-one", confirm: true }, options),
  ).toMatchObject({ outcome: "cancelRequested" });
  expect(
    await taskRequest("cancel", { family: "comfyui", id: "comfy-one", confirm: true }, options),
  ).toMatchObject({ outcome: "notQueued" });
  expect(
    await taskRequest("cancel", { family: "render", id: "idea-one", confirm: true }, options),
  ).toMatchObject({ outcome: "cancelRequested" });
  expect(calls.filter((call) => !call.startsWith("GET"))).toEqual([
    "POST /mount/api/media/cancel/task-one",
    "POST /mount/api/media/comfyui/cancel/comfy-one",
    "DELETE /mount/api/make/idea-one",
  ]);
});

it("fails closed on redirect, oversized data, identity mismatch and unconfirmed cancellation", async () => {
  let mode = "redirect";
  const options = await start((route) =>
    mode === "redirect"
      ? { status: 302, redirect: "/stolen" }
      : mode === "large"
        ? { value: "x".repeat(1024 * 1024) }
        : route === "/mount/api/tasks"
          ? {}
          : { value: { taskId: "wrong", state: "success", isFinal: true } },
  );
  await expect(taskRequest("list", {}, options)).rejects.toMatchObject({
    code: "transport-failed",
  });
  expect(calls).toEqual(["GET /mount/api/tasks"]);
  mode = "large";
  await expect(taskRequest("list", {}, options)).rejects.toMatchObject({
    code: "response-too-large",
  });
  mode = "mismatch";
  await expect(
    taskRequest("status", { family: "media", id: "task-one" }, options),
  ).rejects.toMatchObject({ code: "invalid-task-response" });
  await expect(
    taskRequest("cancel", { family: "media", id: "task-one", confirm: true }, options),
  ).rejects.toMatchObject({ code: "invalid-task-response" });
});

it("MCP uses host credentials and rejects injected endpoints and unconfirmed writes", async () => {
  const options = await start(),
    env = { GLINT_CONTAINER_ENDPOINT: options.endpoint, GLINT_ACCESS_TOKEN: token };
  const handler = createMcpHandler(taskTools(env));
  const call = (name: string, args: Record<string, unknown>) =>
    handler({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  expect(await call("glint_tasks_list", { endpoint: options.endpoint })).toMatchObject({
    result: { isError: true },
  });
  expect(await call("glint_tasks_cancel", { family: "media", id: "task-one" })).toMatchObject({
    result: { isError: true },
  });
  expect(calls).toEqual([]);
  const result = await call("glint_tasks_list", {});
  expect(JSON.stringify(result)).not.toContain("private");
  expect(JSON.stringify(result)).toContain("task-one");
  const logs: string[] = [];
  expect(
    await runTasks(["cancel", "--family=media", "--id=task-one"], env, (line) => logs.push(line)),
  ).toBe(2);
  expect(JSON.parse(logs[0]!).error).toBe("confirmation-required");
});

it("real CLI process reaches the same HTTP task endpoint", async () => {
  const options = await start();
  const cli = fileURLToPath(new URL("./glint.ts", import.meta.url));
  const tsx = createRequire(import.meta.url).resolve("tsx/cli");
  const child = spawn(process.execPath, [tsx, cli, "tasks", "list"], {
    env: { ...process.env, GLINT_CONTAINER_ENDPOINT: options.endpoint, GLINT_ACCESS_TOKEN: token },
    windowsHide: true,
  });
  let output = "",
    error = "";
  child.stdout.on("data", (data) => (output += String(data)));
  child.stderr.on("data", (data) => (error += String(data)));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  expect(code, error).toBe(0);
  expect(JSON.parse(output).tasks).toHaveLength(3);
  expect(output).not.toMatch(/private|prompt|https:/);
  expect(calls).toEqual(["GET /mount/api/tasks"]);
});
