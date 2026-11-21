import { containerV2Tools } from "./container-v2-mcp";
import type { ContainerAction } from "./container-api-client";
import type { McpTool } from "./mcp";
import { listContainers, containerRequest } from "./container-api-client";
import { containerHistoryFields, toolMeta } from "./mcp-registry";

function exact(args: Record<string, unknown>, fields: string[]) {
  if (Object.keys(args).some(key => !fields.includes(key))) throw new Error("Unknown container argument; configure the endpoint and credentials in the MCP process environment");
}

/** Only the host process chooses the service and credentials, never a model tool argument. */
export function containerTools(env: NodeJS.ProcessEnv = process.env): McpTool[] {
  const request = (action: ContainerAction, body: Record<string, unknown>) => {
    const endpoint = env.GLINT_CONTAINER_ENDPOINT;
    if (!endpoint) throw new Error("Set GLINT_CONTAINER_ENDPOINT on the MCP process to connect to an existing Glint service");
    return containerRequest(action, body, { endpoint, token: env.GLINT_ACCESS_TOKEN });
  };
  const tools: McpTool[] = [
    {
      ...toolMeta("glint_container_snapshot"),
      call: args => { exact(args, ["projectId"]); return request("snapshot", args); },
    },
    {
      ...toolMeta("glint_container_open"),
      call: args => { exact(args, ["projectId", "project"]); return request("open", { ...args, createOnly: true }); },
    },
    {
      ...toolMeta("glint_container_append"),
      call: args => {
        exact(args, ["projectId", "transactionId", "baseRevision", "intent", "changes"]);
        return request("append", { projectId: args.projectId, transaction: { id: args.transactionId, baseRevision: args.baseRevision, actor: "skill", scope: {}, intent: args.intent ?? "Edit via MCP" }, changes: args.changes });
      },
    },
  ];
  for (const action of ["undo", "redo"] as const) tools.push({
    ...toolMeta(`glint_container_${action}`),
    call: args => { exact(args, Object.keys(containerHistoryFields)); return request(action, { ...args, actor: "skill" }); },
  });
  tools.push({
    ...toolMeta("glint_container_list"),
    call: args => {
      exact(args, ["limit", "cursor"]);
      const endpoint = env.GLINT_CONTAINER_ENDPOINT;
      if (!endpoint) throw new Error("Set GLINT_CONTAINER_ENDPOINT on the MCP process to connect to an existing Glint service");
      if (args.limit !== undefined && (typeof args.limit !== "number" || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > 50)) throw new Error("Invalid list limit");
      if (args.cursor !== undefined && typeof args.cursor !== "string") throw new Error("Invalid list cursor");
      return listContainers({ endpoint, token: env.GLINT_ACCESS_TOKEN, ...(args.limit === undefined ? {} : { limit: args.limit as number }), ...(args.cursor === undefined ? {} : { cursor: args.cursor as string }) });
    },
  });
  return [...tools, ...containerV2Tools(request)];
}
