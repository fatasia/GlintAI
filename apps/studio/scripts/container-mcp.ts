import { containerV2Tools } from "./container-v2-mcp";
import type { ContainerAction } from "./container-api-client";
import type { McpTool } from "./mcp";
import { listContainers, containerRequest } from "./container-api-client";

const identity = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$" };
const revision = { type: "integer", minimum: 0 };
const historyFields = { projectId: identity, transactionId: identity, baseRevision: revision };
const change = { type: "object", additionalProperties: false, properties: { objectId: identity, versionId: identity, payload: { type: "object" } }, required: ["objectId", "versionId", "payload"] };

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
      name: "glint_container_snapshot",
      description: "Read an existing unified work's documents, immutable versions and shared revision from the configured Glint service.",
      inputSchema: { type: "object", additionalProperties: false, properties: { projectId: identity }, required: ["projectId"] },
      call: args => { exact(args, ["projectId"]); return request("snapshot", args); },
    },
    {
      name: "glint_container_open",
      description: "Import a unified work as a new service copy. Refuses to overwrite an existing work; does not migrate or approve resources.",
      inputSchema: { type: "object", additionalProperties: false, properties: { projectId: identity, project: { type: "object" } }, required: ["projectId", "project"] },
      call: args => { exact(args, ["projectId", "project"]); return request("open", { ...args, createOnly: true }); },
    },
    {
      name: "glint_container_append",
      description: "Save full payloads for existing active scene, timeline, script, design or previz documents in one shared CAS transaction. Read the revision first; keep transaction/version IDs unchanged after an uncertain response.",
      inputSchema: { type: "object", additionalProperties: false, properties: { ...historyFields, intent: { type: "string", maxLength: 2000 }, changes: { type: "array", minItems: 1, maxItems: 100, items: change } }, required: ["projectId", "transactionId", "baseRevision", "changes"] },
      call: args => {
        exact(args, ["projectId", "transactionId", "baseRevision", "intent", "changes"]);
        return request("append", { projectId: args.projectId, transaction: { id: args.transactionId, baseRevision: args.baseRevision, actor: "skill", scope: {}, intent: args.intent ?? "Edit via MCP" }, changes: args.changes });
      },
    },
  ];
  for (const action of ["undo", "redo"] as const) tools.push({
    name: `glint_container_${action}`,
    description: `${action === "undo" ? "Undo" : "Redo"} the latest shared work transaction, including edits from other document views. Requires the current revision and a stable transaction ID.`,
    inputSchema: { type: "object", additionalProperties: false, properties: historyFields, required: ["projectId", "transactionId", "baseRevision"] },
    call: args => { exact(args, Object.keys(historyFields)); return request(action, { ...args, actor: "skill" }); },
  });
  tools.push({
    name: "glint_container_list", description: "Find existing unified works by paginated metadata; read the chosen project snapshot before editing.",
    inputSchema: { type: "object", additionalProperties: false, properties: { limit: { type: "integer", minimum: 1, maximum: 50 }, cursor: identity } },
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
