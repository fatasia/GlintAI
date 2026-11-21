/**
 * M-06d: single source of truth for the MCP tool catalog. Every entry describes
 * one capability once — name, title, description and inputSchema — plus the
 * surfaces where it is reachable and the underlying service action. The MCP
 * assembler (`mcp.ts`), the container/task subentries and the cross-surface
 * consistency test all read from here; call behavior stays with the module
 * that owns the transport.
 */
export type McpSurface = "mcp" | "cli" | "web";

export interface McpToolSpec {
  name: string;
  /** Short human label for catalogs; not sent over MCP tools/list. */
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Where the capability is reachable. "mcp" always applies. */
  surfaces: McpSurface[];
  /** CLI invocation shape; required when surfaces includes "cli". */
  cli?: string;
  /** Underlying container/task service actions; absent for local verbs. */
  actions?: string[];
}

// Shared schema fragments. Values are copied verbatim from the pre-registry
// tool definitions so tools/list output stays byte-identical.
export const containerIdentity = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$" };
export const containerRevision = { type: "integer", minimum: 0 };
/** Transaction history arguments shared by append/undo/redo/lifecycle schemas. */
export const containerHistoryFields = {
  projectId: containerIdentity,
  transactionId: containerIdentity,
  baseRevision: containerRevision,
};
const containerChange = {
  type: "object",
  additionalProperties: false,
  properties: {
    objectId: containerIdentity,
    versionId: containerIdentity,
    payload: { type: "object" },
  },
  required: ["objectId", "versionId", "payload"],
};
const lifecycleChange = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { const: "add" },
        objectId: containerIdentity,
        versionId: containerIdentity,
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
      properties: { action: { enum: ["archive", "restore"] }, objectId: containerIdentity },
      required: ["action", "objectId"],
    },
  ],
};
const PROJECT = { type: "string", description: "Path to a SceneScript project JSON file" } as const;
const CHANGES = {
  type: "array",
  items: { type: "string" },
  description: 'Typed path=value edits, e.g. scenes[1].title="New"',
} as const;
const taskFamily = { type: "string", enum: ["render", "media", "comfyui"] };
const taskId = { type: "string", pattern: "^[a-zA-Z0-9_-]{1,100}$" };

/**
 * The catalog. Order is the tools/list order: container tools, task tools,
 * then the four verbs plus verify (the order `defaultTools()` assembles).
 */
export const MCP_TOOL_REGISTRY: McpToolSpec[] = [
  // Container surface: snapshot/open/append/undo/redo/list (v1) + migrate_copy/lifecycle (v2).
  {
    name: "glint_container_snapshot",
    title: "Read container snapshot",
    description:
      "Read an existing unified work's documents, immutable versions and shared revision from the configured Glint service.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { projectId: containerIdentity },
      required: ["projectId"],
    },
    surfaces: ["mcp", "cli", "web"],
    cli: "glint container snapshot --id=<projectId>",
    actions: ["snapshot"],
  },
  {
    name: "glint_container_open",
    title: "Open work copy",
    description:
      "Import a unified work as a new service copy. Refuses to overwrite an existing work; does not migrate or approve resources.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { projectId: containerIdentity, project: { type: "object" } },
      required: ["projectId", "project"],
    },
    surfaces: ["mcp", "cli", "web"],
    cli: "glint container open --request=<file>",
    actions: ["open"],
  },
  {
    name: "glint_container_append",
    title: "Append changes",
    description:
      "Save full payloads for existing active scene, timeline, script, design or previz documents in one shared CAS transaction. Read the revision first; keep transaction/version IDs unchanged after an uncertain response.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...containerHistoryFields,
        intent: { type: "string", maxLength: 2000 },
        changes: { type: "array", minItems: 1, maxItems: 100, items: containerChange },
      },
      required: ["projectId", "transactionId", "baseRevision", "changes"],
    },
    surfaces: ["mcp", "cli", "web"],
    cli: "glint container append --request=<file>",
    actions: ["append"],
  },
  {
    name: "glint_container_undo",
    title: "Undo transaction",
    description:
      "Undo the latest shared work transaction, including edits from other document views. Requires the current revision and a stable transaction ID.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: containerHistoryFields,
      required: ["projectId", "transactionId", "baseRevision"],
    },
    surfaces: ["mcp", "cli", "web"],
    cli: "glint container undo --request=<file>",
    actions: ["undo"],
  },
  {
    name: "glint_container_redo",
    title: "Redo transaction",
    description:
      "Redo the latest shared work transaction, including edits from other document views. Requires the current revision and a stable transaction ID.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: containerHistoryFields,
      required: ["projectId", "transactionId", "baseRevision"],
    },
    surfaces: ["mcp", "cli", "web"],
    cli: "glint container redo --request=<file>",
    actions: ["redo"],
  },
  {
    name: "glint_container_list",
    title: "List works",
    description:
      "Find existing unified works by paginated metadata; read the chosen project snapshot before editing.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 50 },
        cursor: containerIdentity,
      },
    },
    // "list" is a dedicated paginated route: reachable from MCP and CLI only;
    // the Web container workspace has no list action (recorded difference).
    surfaces: ["mcp", "cli"],
    cli: "glint container list [--limit=N] [--cursor=<projectId>]",
    actions: ["list"],
  },
  {
    name: "glint_container_migrate_copy",
    title: "Migrate to v2 copy",
    description:
      "Explicitly migrate a saved work to a new v2 project ID. Keeps original files and journal unchanged; no automatic upgrade.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { projectId: containerIdentity, sourceProjectId: containerIdentity },
      required: ["projectId", "sourceProjectId"],
    },
    surfaces: ["mcp", "cli", "web"],
    cli: "glint container migrate-copy --request=<file>",
    actions: ["migrate-copy"],
  },
  {
    name: "glint_container_lifecycle",
    title: "Document lifecycle",
    description:
      "Add, archive or restore a document in a v2 work through shared CAS/history. Undo creation archives the identity; it never deletes versions. Requires current revision and stable IDs.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectId: containerIdentity,
        transactionId: containerIdentity,
        baseRevision: containerRevision,
        change: lifecycleChange,
      },
      required: ["projectId", "transactionId", "baseRevision", "change"],
    },
    surfaces: ["mcp", "cli", "web"],
    cli: "glint container lifecycle --request=<file>",
    actions: ["lifecycle"],
  },
  // Task surface: the Web task center drives the same routes via task-center-client,
  // so these entries stay scoped to the MCP/CLI surfaces this registry asserts.
  {
    name: "glint_tasks_list",
    title: "List tasks",
    description:
      "List existing Glint tasks by safe metadata; never includes prompts or provider URLs.",
    inputSchema: { type: "object", additionalProperties: false, properties: {}, required: [] },
    surfaces: ["mcp", "cli"],
    cli: "glint tasks list",
    actions: ["list"],
  },
  {
    name: "glint_tasks_status",
    title: "Task status",
    description:
      "Query an existing listed task without resubmission. Missing task IDs must be recovered in the original entry.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { family: taskFamily, id: taskId },
      required: ["family", "id"],
    },
    surfaces: ["mcp", "cli"],
    cli: "glint tasks status --family=<family> --id=<id>",
    actions: ["status"],
  },
  {
    name: "glint_tasks_cancel",
    title: "Cancel task",
    description:
      "Request cancellation of a listed task only after explicit user confirmation. Comfy queue deletion does not stop a running prompt.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { family: taskFamily, id: taskId, confirm: { type: "boolean", const: true } },
      required: ["family", "id", "confirm"],
    },
    surfaces: ["mcp", "cli"],
    cli: "glint tasks cancel --family=<family> --id=<id> --confirm",
    actions: ["cancel"],
  },
  // Core verbs plus verify (local domain calls, no service route).
  {
    name: "glint_plan",
    title: "Plan a change",
    description:
      "Predict which build nodes a change will execute, what it costs and how long it takes. Does not render.",
    inputSchema: {
      type: "object",
      properties: {
        project: PROJECT,
        changes: CHANGES,
        tts: { type: "string" },
        music: { type: "string" },
        fast: { type: "boolean" },
      },
      required: ["project"],
    },
    surfaces: ["mcp", "cli"],
    cli: "glint plan --project=<project.json> [--set=path=value]",
  },
  {
    name: "glint_apply",
    title: "Apply edits",
    description:
      "Apply path=value edits through the shared session domain (same undo history as the studio) and write the project back, with compare-and-swap on the revision.",
    inputSchema: {
      type: "object",
      properties: { project: PROJECT, changes: CHANGES, expectedRevision: { type: "string" } },
      required: ["project", "changes"],
    },
    surfaces: ["mcp", "cli"],
    cli: "glint apply --project=<project.json> --set=path=value",
  },
  {
    name: "glint_build",
    title: "Build video",
    description:
      "Build (render) a project, write a receipt next to the output, and compare actual execution with the predicted change set.",
    inputSchema: {
      type: "object",
      properties: {
        project: PROJECT,
        out: { type: "string" },
        changes: CHANGES,
        tts: { type: "string" },
        music: { type: "string" },
        fast: { type: "boolean" },
        plate: { type: "boolean" },
        assertBudget: { type: "boolean" },
      },
      required: ["project", "out"],
    },
    surfaces: ["mcp", "cli"],
    cli: "glint build --project=<project.json> --out=<output>",
  },
  {
    name: "glint_prove",
    title: "Run assertions",
    description:
      "Evaluate a glint.tests.json assertion file against a project, plan and optional receipt.",
    inputSchema: {
      type: "object",
      properties: {
        project: PROJECT,
        tests: { type: "string" },
        receipt: { type: "string" },
        changes: CHANGES,
      },
      required: ["project", "tests"],
    },
    surfaces: ["mcp", "cli"],
    cli: "glint prove --project=<project.json> --tests=glint.tests.json",
  },
  {
    name: "glint_verify",
    title: "Verify receipt",
    description:
      "Validate a build receipt: output hash, environment drift, and optionally rebuild and compare.",
    inputSchema: {
      type: "object",
      properties: {
        receipt: { type: "string" },
        rebuild: { type: "boolean" },
        skipEnv: { type: "boolean" },
      },
      required: ["receipt"],
    },
    surfaces: ["mcp", "cli"],
    cli: "glint verify --receipt=<output.receipt.json>",
  },
];

/** Registry metadata for one tool, keyed by MCP tool name. */
export function toolMeta(name: string): Pick<McpToolSpec, "name" | "description" | "inputSchema"> {
  const spec = MCP_TOOL_REGISTRY.find((entry) => entry.name === name);
  if (!spec) throw new Error(`Tool not registered in mcp-registry: ${name}`);
  return { name: spec.name, description: spec.description, inputSchema: spec.inputSchema };
}
