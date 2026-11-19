import type { McpTool } from "./mcp";
import { taskRequest, serviceEnvironment } from "./task-api-client";

/** Host credentials and endpoint are never model-controlled arguments. */
export function taskTools(env: NodeJS.ProcessEnv = process.env): McpTool[] {
  return (["list", "status", "cancel"] as const).map((action) => ({
    name: `glint_tasks_${action}`,
    description:
      action === "list"
        ? "List existing Glint tasks by safe metadata; never includes prompts or provider URLs."
        : action === "status"
          ? "Query an existing listed task without resubmission. Missing task IDs must be recovered in the original entry."
          : "Request cancellation of a listed task only after explicit user confirmation. Comfy queue deletion does not stop a running prompt.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties:
        action === "list"
          ? {}
          : {
              family: { type: "string", enum: ["render", "media", "comfyui"] },
              id: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,100}$" },
              ...(action === "cancel" ? { confirm: { type: "boolean", const: true } } : {}),
            },
      required:
        action === "list"
          ? []
          : action === "cancel"
            ? ["family", "id", "confirm"]
            : ["family", "id"],
    },
    call: (args) => taskRequest(action, args, serviceEnvironment(env)),
  }));
}
