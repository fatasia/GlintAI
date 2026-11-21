import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MCP_TOOL_REGISTRY, toolMeta } from "./mcp-registry";
import { defaultTools } from "./mcp";
import { containerTools } from "./container-mcp";
import { taskTools } from "./task-mcp";
import { CONTAINER_API_ACTIONS } from "./container-api-client";
import { CONTAINER_CLI_ACTIONS } from "./container-cli";
import { TASK_ACTIONS } from "./task-api-client";

const cliSource = readFileSync(fileURLToPath(new URL("./glint.ts", import.meta.url)), "utf8");
// Same extraction contract as skill-doc.test.ts: top-level `case "name"` dispatch.
const cliCommands = new Set([...cliSource.matchAll(/case "([a-z-]+)"/g)].map((match) => match[1]!));
const specByName = new Map(MCP_TOOL_REGISTRY.map((spec) => [spec.name, spec]));
const containerSpecs = MCP_TOOL_REGISTRY.filter((spec) => spec.name.startsWith("glint_container_"));
const taskSpecs = MCP_TOOL_REGISTRY.filter((spec) => spec.name.startsWith("glint_tasks_"));
const actionsOf = (specs: typeof MCP_TOOL_REGISTRY) => specs.flatMap((spec) => spec.actions ?? []);

describe("mcp-registry hygiene", () => {
  it("registers unique glint_* tools with non-empty metadata and object schemas", () => {
    const names = MCP_TOOL_REGISTRY.map((spec) => spec.name);
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
    for (const spec of MCP_TOOL_REGISTRY) {
      expect(spec.name).toMatch(/^glint_[a-z0-9_]+$/);
      expect(spec.title.length).toBeGreaterThan(0);
      expect(spec.description.length).toBeGreaterThan(10);
      expect((spec.inputSchema as { type?: unknown }).type).toBe("object");
      expect(spec.surfaces).toContain("mcp");
      expect(new Set(spec.surfaces).size).toBe(spec.surfaces.length);
      if (spec.surfaces.includes("cli"))
        expect(spec.cli, `${spec.name} needs a cli shape`).toBeTruthy();
    }
  });
  it("resolves every registry name through toolMeta", () => {
    for (const spec of MCP_TOOL_REGISTRY) expect(toolMeta(spec.name).name).toBe(spec.name);
    expect(() => toolMeta("glint_ghost")).toThrow("Tool not registered in mcp-registry");
  });
});

describe("registry is the single assembly source", () => {
  it("guards the registry entry count against default tool drift", () => {
    expect(MCP_TOOL_REGISTRY).toHaveLength(defaultTools().length);
  });
  it("exposes default tools whose metadata equals the registry entries verbatim", () => {
    for (const tool of defaultTools()) {
      const spec = specByName.get(tool.name);
      expect(spec, `unregistered default tool: ${tool.name}`).toBeTruthy();
      expect(tool.description).toBe(spec!.description);
      expect(tool.inputSchema).toEqual(spec!.inputSchema);
    }
  });
  it("keeps the container and task subentries in registry order", () => {
    expect(containerTools({}).map((tool) => tool.name)).toEqual(
      containerSpecs.map((spec) => spec.name),
    );
    expect(taskTools({}).map((tool) => tool.name)).toEqual(taskSpecs.map((spec) => spec.name));
  });
});

describe("cross-surface consistency (MCP/CLI/Web)", () => {
  it("declares service actions only for routes the service really exposes", () => {
    const knownActions = new Set<string>([...CONTAINER_API_ACTIONS, "list", ...TASK_ACTIONS]);
    for (const spec of MCP_TOOL_REGISTRY) {
      for (const action of spec.actions ?? []) {
        expect(knownActions.has(action), `${spec.name} declares unknown action "${action}"`).toBe(
          true,
        );
      }
    }
  });
  it("covers the web container whitelist exactly once per action", () => {
    // Recorded difference: "list" is a dedicated route reachable from MCP and CLI only,
    // so it is registered with surfaces ["mcp","cli"] and stays out of this assertion.
    const declared = actionsOf(containerSpecs.filter((spec) => spec.surfaces.includes("web")));
    expect(new Set(declared).size).toBe(declared.length);
    expect([...declared].sort()).toEqual([...CONTAINER_API_ACTIONS].sort());
    // Web-labelled entries never claim actions outside the whitelist.
    for (const action of declared) expect(CONTAINER_API_ACTIONS).toContain(action);
  });
  it("registers every container/task action the CLIs accept", () => {
    expect([...actionsOf(containerSpecs)].sort()).toEqual([...CONTAINER_CLI_ACTIONS].sort());
    expect([...actionsOf(taskSpecs)].sort()).toEqual([...TASK_ACTIONS].sort());
  });
  it("only teaches CLI invocations the glint dispatcher really implements", () => {
    for (const spec of MCP_TOOL_REGISTRY) {
      if (!spec.surfaces.includes("cli")) continue;
      const command = /^glint ([a-z-]+)/.exec(spec.cli!)?.[1];
      expect(command, `${spec.name} cli shape "${spec.cli}" must name a command`).toBeTruthy();
      expect(cliCommands.has(command!), `${spec.cli} has no glint.ts case`).toBe(true);
    }
  });
});
