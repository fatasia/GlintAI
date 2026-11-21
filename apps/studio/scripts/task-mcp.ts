import type { McpTool } from "./mcp";
import { taskRequest, serviceEnvironment, TASK_ACTIONS, type TaskAction } from "./task-api-client";
import { toolMeta } from "./mcp-registry";

/** Host credentials and endpoint are never model-controlled arguments. */
export function taskTools(env: NodeJS.ProcessEnv = process.env): McpTool[] {
  return TASK_ACTIONS.map((action: TaskAction): McpTool => ({
    ...toolMeta(`glint_tasks_${action}`),
    call: (args: Record<string, unknown>) => taskRequest(action, args, serviceEnvironment(env)),
  }));
}
