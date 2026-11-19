// Test-integrity guard (quality gate G9).
// Compares HEAD with its merge-base and fails when tests were weakened, unless the
// branch carries a reviewed `TEST-CHANGE:` reason. Only the diff is inspected, so there
// is no baseline file to maintain.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RULES = {
  T1: "新增 skip/only/todo/fails",
  T2: "删除测试文件",
  T3: "断言数量减少",
  T4: "新增或调大超时、重试",
  T5: "修改或删除快照/金标",
  T6: "新增类型或规则压制",
};

const TEST_FILE = /\.(test|spec)\.(ts|tsx|mjs|js)$/;
const SUPPRESSION_SCOPE = /(^|\/)scripts\/|\.(test|spec)\.(ts|tsx|mjs|js)$/;
const SNAPSHOT_PATH = /(^|\/)__snapshots__\/|\.snap$|(^|\/)goldens?\//;
const CONFIG_FILE = /(^|\/)vitest\.config\.(ts|mjs|js)$/;
const MIN_REASON = 20;
const FILLER = /^(见上|同上|n\/?a|无|none|todo|tbd|\.+|-+)$/i;

const T1_PATTERN = /\b(?:it|test|describe)\.(?:skip|only|todo|fails)\b|\b(?:xit|xdescribe|xtest)\s*\(/;
const T6_PATTERN = /@ts-ignore|@ts-expect-error|eslint-disable|\bas any\b|:\s*any\b/;
const ASSERTION = /\bexpect\s*\(|\bassert(?:\.\w+)?\s*\(|\bt\.(?:is|true|false|deepEqual|throws)\s*\(/g;
const TIMEOUT_KEY = /\b(?:testTimeout|hookTimeout|teardownTimeout|timeout|retry|retries)\b\s*[:=]\s*(\d[\d_]*)/g;
const TEST_CALL_TIMEOUT = /\b(?:it|test)\s*\([^\n]*,\s*(\d[\d_]*)\s*\)\s*;?\s*$/;

class GuardError extends Error {}

function git(cwd, args, { allowFail = false } = {}) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    if (allowFail) return null;
    throw new GuardError(`git ${args.join(" ")} 失败：${String(error.stderr ?? error.message).trim()}`);
  }
}

function showFile(cwd, ref, file) {
  const out = git(cwd, ["show", `${ref}:${file}`], { allowFail: true });
  return out === null ? null : out.replace(/\r\n/g, "\n");
}

function readWorking(cwd, file) {
  const full = path.join(cwd, file);
  return fs.existsSync(full) ? fs.readFileSync(full, "utf8").replace(/\r\n/g, "\n") : null;
}

const isBinary = text => text.includes("\0");
const count = (text, pattern) => (text.match(pattern)?.length ?? 0);
const number = raw => Number(raw.replaceAll("_", ""));

function timeouts(text) {
  const values = [];
  for (const line of text.split("\n")) {
    for (const match of line.matchAll(TIMEOUT_KEY)) values.push(number(match[1]));
    const call = line.match(TEST_CALL_TIMEOUT);
    if (call) values.push(number(call[1]));
  }
  return values;
}

/** `git diff` lines added in a file, with their new line numbers. */
function addedLines(cwd, base, file) {
  const out = git(cwd, ["diff", "--unified=0", "--no-color", "--find-renames", `${base}...HEAD`, "--", file], { allowFail: true }) ?? "";
  const added = [];
  let line = 0;
  for (const row of out.split("\n")) {
    const hunk = row.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunk) { line = Number(hunk[1]); continue; }
    if (row.startsWith("+") && !row.startsWith("+++")) { added.push({ line, text: row.slice(1).replace(/\r$/, "") }); line += 1; }
  }
  return added;
}

function changedFiles(cwd, base) {
  const out = git(cwd, ["diff", "--name-status", "-z", "--find-renames", `${base}...HEAD`]);
  const parts = out.split("\0").filter(Boolean);
  const files = [];
  for (let i = 0; i < parts.length;) {
    const status = parts[i++];
    if (status.startsWith("R") || status.startsWith("C")) files.push({ status: status[0], from: parts[i++], file: parts[i++] });
    else files.push({ status: status[0], file: parts[i++] });
  }
  return files;
}

export function analyze(cwd, base) {
  const findings = [];
  const add = (rule, file, line, detail) => findings.push({ rule, file, line, detail });
  for (const entry of changedFiles(cwd, base)) {
    const { status, file } = entry;
    const origin = entry.from ?? file;
    const isTest = TEST_FILE.test(file) || TEST_FILE.test(origin);
    const isSnapshot = SNAPSHOT_PATH.test(file) || SNAPSHOT_PATH.test(origin);
    const isConfig = CONFIG_FILE.test(file);

    if (status === "D" && isTest) add("T2", file, 1, "测试文件被删除");
    if (isSnapshot && (status === "M" || status === "D")) add("T5", file, 1, status === "D" ? "快照/金标被删除" : "快照/金标被修改");
    if (status === "D") continue;

    const before = status === "A" ? "" : showFile(cwd, base, origin) ?? "";
    const after = showFile(cwd, "HEAD", file);
    if (after === null || isBinary(after) || isBinary(before)) continue;

    if ((isTest || isConfig) && status !== "A") {
      const was = timeouts(before), now = timeouts(after);
      const maxWas = was.length ? Math.max(...was) : 0, maxNow = now.length ? Math.max(...now) : 0;
      if (maxNow > maxWas) add("T4", file, 1, `超时/重试上限 ${maxWas} → ${maxNow}`);
    }
    if (isTest) {
      const wasCount = count(before, ASSERTION), nowCount = count(after, ASSERTION);
      if (status !== "A" && nowCount < wasCount) add("T3", file, 1, `断言数量 ${wasCount} → ${nowCount}`);
    }
    if (isTest || SUPPRESSION_SCOPE.test(file)) {
      for (const { line, text } of addedLines(cwd, base, file)) {
        if (isTest && T1_PATTERN.test(text)) add("T1", file, line, text.trim());
        if (SUPPRESSION_SCOPE.test(file) && T6_PATTERN.test(text)) add("T6", file, line, text.trim());
      }
    }
  }
  return findings;
}

/** Parses TEST-CHANGE reasons. Returns { all: reason | null, rules: Map<rule, reason> }. */
export function parseReasons(text) {
  const result = { all: null, rules: new Map() };
  for (const match of text.matchAll(/TEST-CHANGE:\s*((?:T[1-6](?:\s*,\s*T[1-6])*)?)\s*([^\n]*)/g)) {
    const reason = match[2].trim();
    if (reason.length < MIN_REASON || FILLER.test(reason)) continue;
    const rules = match[1] ? match[1].split(",").map(item => item.trim()) : [];
    if (!rules.length) result.all = reason;
    for (const rule of rules) result.rules.set(rule, reason);
  }
  return result;
}

function reasonText(cwd, base, options) {
  const parts = [];
  if (process.env.TEST_CHANGE_REASON) parts.push(process.env.TEST_CHANGE_REASON);
  if (options.prBodyFile) {
    if (!fs.existsSync(options.prBodyFile)) throw new GuardError(`找不到 PR 说明文件：${options.prBodyFile}`);
    parts.push(fs.readFileSync(options.prBodyFile, "utf8"));
  }
  parts.push(git(cwd, ["log", `${base}..HEAD`, "--format=%B"], { allowFail: true }) ?? "");
  return parts.join("\n");
}

export function resolveBase(cwd, requested) {
  const candidates = requested ? [requested] : ["origin/main", "main"];
  for (const ref of candidates) {
    if (git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { allowFail: true }) === null) continue;
    const mergeBase = git(cwd, ["merge-base", ref, "HEAD"], { allowFail: true });
    if (mergeBase) return mergeBase.trim();
  }
  throw new GuardError(`找不到基线分支（已尝试：${candidates.join("、")}）。请先运行 git fetch origin main，或用 --base <ref> 指定。`);
}

export function run(argv, cwd = process.cwd()) {
  const options = { json: false, base: undefined, prBodyFile: undefined };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--json") options.json = true;
    else if (argv[i] === "--base") options.base = argv[++i];
    else if (argv[i] === "--pr-body-file") options.prBodyFile = argv[++i];
    else throw new GuardError(`未知参数：${argv[i]}`);
  }
  if (git(cwd, ["rev-parse", "--is-inside-work-tree"], { allowFail: true })?.trim() !== "true") throw new GuardError("当前目录不在 git 仓库中。");
  const base = resolveBase(cwd, options.base);
  const findings = analyze(cwd, base);
  const reasons = parseReasons(reasonText(cwd, base, options));
  for (const finding of findings) {
    const reason = reasons.rules.get(finding.rule) ?? reasons.all;
    if (reason) finding.waived = reason;
  }
  const blocking = findings.filter(item => !item.waived);
  const ok = blocking.length === 0;
  const lines = findings.map(item => `${item.rule} ${item.file}:${item.line} ${RULES[item.rule]}：${item.detail}${item.waived ? `\n   ↳ 已由 TEST-CHANGE 放行：${item.waived}` : ""}`);
  const summary = findings.length === 0 ? "没有测试文件变化或削弱。" : `${blocking.length} 处未放行，${findings.length - blocking.length} 处已由 TEST-CHANGE 放行。`;
  return { ok, exitCode: ok ? 0 : 1, base, findings, summary, lines };
}

function main() {
  const json = process.argv.includes("--json");
  try {
    const result = run(process.argv.slice(2));
    if (json) console.log(JSON.stringify(result, null, 2));
    else {
      for (const line of result.lines) console.log(line);
      console.log(`${result.ok ? "测试完整性检查通过" : "测试完整性检查未通过"}：${result.summary}`);
    }
    process.exitCode = result.exitCode;
  } catch (error) {
    if (!(error instanceof GuardError)) throw error;
    if (json) console.log(JSON.stringify({ ok: false, exitCode: 2, error: error.message }));
    else console.error(`测试完整性检查无法运行：${error.message}`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
