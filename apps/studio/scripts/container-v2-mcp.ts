import type { McpTool } from "./mcp";
import type { ContainerAction, ContainerApiResult } from "./container-api-client";
type Request = (
  action: ContainerAction,
  body: Record<string, unknown>,
) => Promise<ContainerApiResult>;
const identity = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$" };
function exact(args: Record<string, unknown>, fields: string[]) {
  if (Object.keys(args).some((key) => !fields.includes(key)))
    throw new Error("Unknown container argument");
}
const lifecycleSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    projectId: identity,
    transactionId: identity,
    baseRevision: { type: "integer", minimum: 0 },
    change: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          properties: {
            action: { const: "add" },
            objectId: identity,
            versionId: identity,
            kind: {
              enum: [
                "scene-document",
                "timeline-document",
                "script-document",
                "design-document",
                "previz-document",
              ],
            },
            payload: { type: "object" },
          },
          required: ["action", "objectId", "versionId", "kind", "payload"],
        },
        {
          type: "object",
          additionalProperties: false,
          properties: { action: { enum: ["archive", "restore"] }, objectId: identity },
          required: ["action", "objectId"],
        },
      ],
    },
  },
  required: ["projectId", "transactionId", "baseRevision", "change"],
};
export function containerV2Tools(request: Request): McpTool[] {
  return [
    {
      name: "glint_container_migrate_copy",
      description:
        "Explicitly migrate a saved work to a new v2 project ID. Keeps original files and journal unchanged; no automatic upgrade.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { projectId: identity, sourceProjectId: identity },
        required: ["projectId", "sourceProjectId"],
      },
      call: (args) => {
        exact(args, ["projectId", "sourceProjectId"]);
        return request("migrate-copy", args);
      },
    },
    {
      name: "glint_container_lifecycle",
      description:
        "Add, archive or restore a document in a v2 work through shared CAS/history. Undo creation archives the identity; it never deletes versions. Requires current revision and stable IDs.",
      inputSchema: lifecycleSchema,
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
