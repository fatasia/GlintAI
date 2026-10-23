import fs from "node:fs";
import path from "node:path";
import { parseProject } from "@glintai/scenescript";
import { validateReceipt, environmentDrift, type Receipt } from "@glintai/buildgraph";
import { planProject, environmentFingerprint, type PlanInput } from "./build";
import { readArg } from "./glint-runtime";

export interface AssertionResult {
  assert: unknown;
  pass: boolean;
  detail: string;
}

export interface ProofReport {
  project: string;
  revision: string;
  results: AssertionResult[];
  pass: boolean;
}

const SUPPORTED = ["only", "change", "determinism", "output", "scenes", "provenance"] as const;

/**
 * Assertions are deliberately small and machine-checkable. Anything that would
 * need OCR or a human eye is rejected instead of silently passing: a proof that
 * cannot be evaluated must never look green.
 */
export function parseAssertions(value: unknown): Record<string, unknown>[] {
  const list = Array.isArray(value) ? value : (value as { assert?: unknown })?.assert;
  if (!Array.isArray(list) || list.length === 0) throw new Error("Tests file must contain an assert array");
  if (list.length > 100) throw new Error("Too many assertions (max 100)");
  return list.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`Assertion ${index} must be an object`);
    const keys = Object.keys(entry);
    if (keys.length !== 1) throw new Error(`Assertion ${index} must have exactly one key, got: ${keys.join(", ") || "none"}`);
    const key = keys[0]!;
    if (!(SUPPORTED as readonly string[]).includes(key)) throw new Error(`Assertion ${index} uses unsupported predicate "${key}". Supported: ${SUPPORTED.join(", ")}`);
    return entry as Record<string, unknown>;
  });
}

function sceneIds(nodes: readonly string[]): string[] {
  return nodes.filter(id => id.startsWith("scene:")).map(id => id.slice(6));
}

export interface ProveInput extends PlanInput {
  testsPath: string;
  receiptPath?: string;
}

export function proveProject(input: ProveInput): ProofReport {
  const projectPath = path.resolve(input.projectPath);
  const project = parseProject(JSON.parse(fs.readFileSync(projectPath, "utf8")));
  const assertions = parseAssertions(JSON.parse(fs.readFileSync(path.resolve(input.testsPath), "utf8")));
  const plan = planProject(input);
  const receipt: Receipt | undefined = input.receiptPath ? validateReceipt(JSON.parse(fs.readFileSync(path.resolve(input.receiptPath), "utf8"))) : undefined;
  const results: AssertionResult[] = [];
  for (const assertion of assertions) {
    const [key, value] = Object.entries(assertion)[0]!;
    try {
      if (key === "only") {
        if (!Array.isArray(value) || value.some(id => typeof id !== "string")) throw new Error("only expects an array of scene ids");
        const predicted = [...new Set([...sceneIds(plan.plan.changed), ...sceneIds(plan.plan.predicted)])];
        const unexpected = predicted.filter(id => !(value as string[]).includes(id));
        results.push({ assert: assertion, pass: unexpected.length === 0, detail: unexpected.length ? `unexpected scenes would change: ${unexpected.join(", ")}` : `only ${predicted.join(", ") || "nothing"} would change` });
      } else if (key === "change") {
        const options = value as { maxCostCny?: number; maxModelCalls?: number };
        if (!options || typeof options !== "object") throw new Error("change expects an object");
        const failures: string[] = [];
        if (options.maxCostCny !== undefined && plan.plan.costCny > options.maxCostCny) failures.push(`cost ¥${plan.plan.costCny.toFixed(2)} > ¥${options.maxCostCny}`);
        const modelCalls = receipt?.totals.modelCalls ?? 0;
        if (options.maxModelCalls !== undefined && modelCalls > options.maxModelCalls) failures.push(`model calls ${modelCalls} > ${options.maxModelCalls}`);
        results.push({ assert: assertion, pass: failures.length === 0, detail: failures.join("; ") || `cost ¥${plan.plan.costCny.toFixed(2)}, ${modelCalls} model call(s)` });
      } else if (key === "determinism") {
        if (!receipt) throw new Error("determinism needs --receipt from a completed build");
        const level = (value as { level?: string })?.level ?? "L0";
        if (!["L0", "L1"].includes(level)) throw new Error("determinism.level must be L0 or L1");
        const rank: Record<string, number> = { L0: 0, L1: 1, L2: 2 };
        const strongEnough = rank[receipt.reproducibility]! <= rank[level]!;
        const drift = environmentDrift(receipt.environment, environmentFingerprint({ browserRequired: (receipt.environment.browser ?? "none") !== "none" }));
        results.push({ assert: assertion, pass: strongEnough && drift.length === 0, detail: !strongEnough ? `receipt is ${receipt.reproducibility}, assertion needs ${level}` : drift.length ? `environment drift: ${drift.join("; ")}` : `${receipt.reproducibility} verified, environment matches` });
      } else if (key === "output") {
        if (!receipt?.output) throw new Error("output assertion needs --receipt with an output block");
        const options = (value ?? {}) as { minBytes?: number };
        const exists = fs.existsSync(receipt.output.path);
        const bytes = exists ? fs.statSync(receipt.output.path).size : 0;
        const pass = exists && (options.minBytes === undefined || bytes >= options.minBytes);
        results.push({ assert: assertion, pass, detail: exists ? `${bytes} bytes` : `missing: ${receipt.output.path}` });
      } else if (key === "provenance") {
        if (!receipt?.provenance?.length || !receipt.output?.frames) throw new Error("provenance needs --receipt with provenance and frame count");
        const coverage = new Uint16Array(receipt.output.frames);
        for (const range of receipt.provenance) for (let frame = range.frameRange[0]; frame <= range.frameRange[1] && frame < coverage.length; frame++) coverage[frame] = (coverage[frame] ?? 0) + 1;
        const covered = coverage.every(count => count === 1);
        results.push({ assert: assertion, pass: covered, detail: covered ? `${receipt.output.frames} frames covered by ${receipt.provenance.length} range(s)` : "provenance gaps or overlaps" });
      } else if (key === "scenes") {
        const expected = (value as { count?: number })?.count;
        if (!Number.isInteger(expected)) throw new Error("scenes expects { count: number }");
        results.push({ assert: assertion, pass: project.scenes.length === expected, detail: `${project.scenes.length} scene(s), expected ${expected}` });
      }
    } catch (error) {
      results.push({ assert: assertion, pass: false, detail: error instanceof Error ? error.message : String(error) });
    }
  }
  return { project: project.id, revision: plan.revision, results, pass: results.every(result => result.pass) };
}

/** `glint prove --project=p.json --tests=glint.tests.json [--receipt=r.json] [--out=proof.json]` */
export function runProve(args: string[]): ProofReport {
  const projectPath = readArg(args, "project"), testsPath = readArg(args, "tests");
  if (!projectPath || !testsPath) throw new Error("prove requires --project=<scenescript.json> and --tests=<glint.tests.json>");
  const report = proveProject({
    projectPath, testsPath, receiptPath: readArg(args, "receipt"),
    changes: args.filter(arg => arg.startsWith("--set=")).map(arg => arg.slice(6)),
    tts: readArg(args, "tts"), music: readArg(args, "music"), fast: args.includes("--fast") ? true : undefined,
  });
  for (const result of report.results) console.log(`  ${result.pass ? "✓" : "✗"} ${JSON.stringify(result.assert)} — ${result.detail}`);
  console.log(`[glint] prove ${report.pass ? "PASS" : "FAIL"} (${report.results.filter(result => result.pass).length}/${report.results.length})`);
  const out = readArg(args, "out");
  if (out) { fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true }); fs.writeFileSync(path.resolve(out), JSON.stringify(report, null, 2)); }
  if (!report.pass) process.exitCode = 1;
  return report;
}
