import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAnalyzer, BASELINE, inScope, strictOnly } from "./quality-analyzer.mjs";
import { policy, trustedBaseline, parseBaseline } from "./quality-baseline.mjs";
import {
  git,
  normalize,
  sha256,
  commitId,
  sourceAt,
  allowedIssues,
  issueKey,
} from "./quality-git.mjs";

export function supportedRuntime(version) {
  const [major, minor] = version.split(".").map(Number);
  return (major === 20 && minor >= 9) || (major === 21 && minor >= 1) || major >= 22;
}
function runtime() {
  if (!supportedRuntime(process.versions.node))
    throw new Error(
      "Code-quality tools require Node 20.9+, 21.1+, or 22+; Node 22 is recommended. Application runtime engines are unchanged.",
    );
}

function files(root) {
  return [
    ...new Set(
      git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).split("\0"),
    ),
  ]
    .filter((file) => inScope(file) && fs.existsSync(path.join(root, file)))
    .sort();
}
function read(root, file) {
  const full = path.join(root, file),
    stat = fs.lstatSync(full);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024)
    throw new Error(`${file}: only regular source files <=4 MiB are supported`);
  return normalize(fs.readFileSync(full, "utf8"));
}
export async function bootstrap(root, source) {
  runtime();
  const commit = commitId(root, source),
    fingerprint = policy(root),
    analyze = await createAnalyzer(root);
  const snapshotFiles = git(root, ["ls-tree", "-r", "--name-only", commit])
    .split("\n")
    .filter((file) => inScope(file) && !strictOnly(file));
  const baseline = {
    version: 1,
    source: commit,
    policy: fingerprint,
    review: "Initial candidate; owner review pending. Not approval.",
    files: {},
  };
  for (const file of snapshotFiles) {
    const text = sourceAt(root, commit, file);
    if (text.length > 4 * 1024 * 1024) throw new Error(`${file}: source too large`);
    const issues = await analyze(file, text);
    baseline.files[file] = { sha256: sha256(text), originalCount: issues.length, issues };
  }
  return baseline;
}
export async function check(root, { base, mode = "all", reduce = false } = {}) {
  runtime();
  if (!base)
    throw new Error("Provide --base=<trusted commit> or QUALITY_BASE; no implicit bootstrap");
  if (!["all", "lint", "format"].includes(mode) || (reduce && mode !== "all"))
    throw new Error("Invalid quality mode");
  const fingerprint = policy(root),
    baseline = trustedBaseline(root, commitId(root, base), fingerprint);
  return evaluate(root, baseline, { mode, reduce });
}
async function evaluate(root, baseline, { mode = "all", reduce = false } = {}) {
  const analyze = await createAnalyzer(root),
    findings = [],
    retained = {},
    report = [];
  const selected = (issue) =>
    mode === "all" || (mode === "format" ? issue.kind !== "lint" : issue.kind !== "format");
  for (const file of files(root)) {
    const text = read(root, file),
      old = strictOnly(file) ? undefined : baseline.files[file];
    if (old && old.issues.length === old.originalCount && sha256(text) === old.sha256) {
      retained[file] = old;
      if (old.issues.length) report.push({ file, legacy: old.issues.length });
      continue;
    }
    const issues = await analyze(file, text);
    let result = { blocked: issues, retained: [] };
    if (old) {
      const previous = sourceAt(root, baseline.source, file);
      if (sha256(previous) !== old.sha256)
        throw new Error(`${file}: baseline source hash mismatch`);
      result = allowedIssues(previous, text, old.issues, issues);
      retained[file] = { ...old, issues: result.retained };
    }
    findings.push(...result.blocked.filter(selected).map((issue) => ({ file, ...issue })));
    if (result.retained.length) report.push({ file, legacy: result.retained.length });
  }
  if (reduce && !findings.length) {
    // Retain the frozen source anchor; only remove allowances, never relocate or add them.
    const reduced = { ...baseline, files: retained };
    fs.writeFileSync(path.join(root, BASELINE), `${JSON.stringify(reduced, null, 2)}\n`);
  }
  return {
    ok: findings.length === 0,
    findings,
    legacy: report,
    retainedKeys: Object.fromEntries(
      Object.entries(retained).map(([file, entry]) => [file, entry.issues.map(issueKey)]),
    ),
  };
}
export async function preview(root, candidateFile) {
  const candidate = parseBaseline(fs.readFileSync(candidateFile, "utf8"));
  if (candidate.policy !== policy(root)) throw new Error("Candidate policy mismatch");
  const measured = await bootstrap(root, candidate.source);
  if (JSON.stringify(candidate.files) !== JSON.stringify(measured.files))
    throw new Error("Candidate does not match independently measured source snapshot");
  const result = await evaluate(root, measured);
  return { ...result, trusted: false, review: "pending", mode: "preview" };
}
export async function main(argv = process.argv.slice(2), root = process.cwd()) {
  const options = {},
    flags = new Set(["--json", "--reduce"]);
  for (const arg of argv) {
    if (flags.has(arg)) {
      options[arg.slice(2)] = true;
      continue;
    }
    const match = /^--(base|mode|bootstrap|output|preview)=(.+)$/.exec(arg);
    if (!match || options[match[1]] !== undefined)
      throw new Error(`Unknown/duplicate argument: ${arg}`);
    options[match[1]] = match[2];
  }
  if (options.preview) {
    if (options.base || options.bootstrap || options.output || options.mode || options.reduce)
      throw new Error("Preview cannot activate or modify a baseline");
    return preview(root, path.resolve(root, options.preview));
  }
  if (options.bootstrap) {
    if (!options.output || options.base || options.reduce || options.mode)
      throw new Error("Bootstrap requires an explicit --output candidate, not a normal check");
    if (
      path.resolve(root, options.output) === path.join(root, BASELINE) ||
      fs.existsSync(path.resolve(root, options.output))
    )
      throw new Error("Bootstrap must not overwrite or activate a baseline");
    const candidate = await bootstrap(root, options.bootstrap);
    fs.writeFileSync(path.resolve(root, options.output), `${JSON.stringify(candidate, null, 2)}\n`);
    return { ok: true, candidate: options.output, review: "pending" };
  }
  if (options.output) throw new Error("Output is only supported for bootstrap");
  return check(root, {
    base: options.base ?? process.env.QUALITY_BASE,
    mode: options.mode ?? "all",
    reduce: Boolean(options.reduce),
  });
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.ok ? 0 : 1;
    })
    .catch((error) => {
      console.error(JSON.stringify({ ok: false, error: error.message }));
      process.exitCode = 2;
    });
}
