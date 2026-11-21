import type { McpTool } from "./mcp";
import type { ContainerAction, ContainerApiResult } from "./container-api-client";
import { toolMeta } from "./mcp-registry";
type Request = (
  action: ContainerAction,
  body: Record<string, unknown>,
) => Promise<ContainerApiResult>;
function exact(args: Record<string, unknown>, fields: string[]) {
  if (Object.keys(args).some((key) => !fields.includes(key)))
    throw new Error("Unknown container argument");
}
export function containerV2Tools(request: Request): McpTool[] {
  return [
    {
      ...toolMeta("glint_container_migrate_copy"),
      call: (args) => {
        exact(args, ["projectId", "sourceProjectId"]);
        return request("migrate-copy", args);
      },
    },
    {
      ...toolMeta("glint_container_lifecycle"),
      call: (args) => {
        exact(args, ["projectId", "transactionId", "baseRevision", "change"]);
        return request("lifecycle", {
          projectId: args.projectId,
          transaction: {
            id: args.transactionId,
            baseRevision: args.baseRevision,
            actor: "skill",
            scope: {},
            intent: "Document lifecycle via MCP",
          },
          change: args.change,
        });
      },
    },
  ];
}
