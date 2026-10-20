import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { analyzeCodeRepo } from "./code-graph";
it("resolves imported, local and method calls without executing the project", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glint-code-graph-"));
  try {
    fs.writeFileSync(
      path.join(dir, "helper.ts"),
      "export function helper(x: number) { return x+1; }",
    );
    fs.writeFileSync(
      path.join(dir, "index.ts"),
      'import {helper as inc} from "./helper"; const local=()=>inc(1); class A { run(){return local()} } const a=new A(); a.run(); unknownExternal();',
    );
    const graph = analyzeCodeRepo(dir),
      name = (id: string) => graph.nodes.find((n) => n.id === id)!.name;
    expect(graph.edges.map((e) => [name(e.from), name(e.to)])).toEqual(
      expect.arrayContaining([
        ["local", "helper"],
        ["run", "local"],
        ["index.ts", "run"],
      ]),
    );
    expect(
      graph.unresolved.some((x) => x.expression === "unknownExternal"),
    ).toBe(true);
    expect(graph.nodes.find((n) => n.name === "helper")?.file).toBe(
      "helper.ts",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
