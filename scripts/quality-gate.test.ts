import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { bootstrap, check, main, supportedRuntime } from "./check-code-quality.mjs";
import { IMPLEMENTATION_FILES } from "./quality-baseline.mjs";
import { BASELINE } from "./quality-analyzer.mjs";
import { git, allowedIssues, sha256 } from "./quality-git.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep))
      throw new Error("Unexpected fixture cleanup");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
function write(root: string, file: string, text: string) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
}
function commit(root: string) {
  git(root, ["add", "."]);
  git(root, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "fixture",
  ]);
  return git(root, ["rev-parse", "HEAD"]).trim();
}
async function fixture(source = "export const oldValue: any = 1;\n") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-quality-test-"));
  roots.push(root);
  git(root, ["init"]);
  git(root, ["config", "core.autocrlf", "false"]);
  git(root, ["config", "core.hooksPath", path.join(root, "no-hooks")]);
  write(root, ".gitignore", "node_modules/\n");
  for (const file of [
    "package.json",
    "eslint.config.mjs",
    "prettier.config.mjs",
    ...IMPLEMENTATION_FILES,
  ]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.copyFileSync(path.join(repository, file), path.join(root, file));
  }
  fs.symlinkSync(
    path.join(repository, "node_modules"),
    path.join(root, "node_modules"),
    "junction",
  );
  write(root, "apps/test/old.ts", source);
  const original = commit(root),
    candidate = await bootstrap(root, original);
  write(root, BASELINE, `${JSON.stringify(candidate, null, 2)}\n`);
  return { root, base: commit(root), original };
}
it("reports unchanged debt, permits unrelated insertions and normalizes CRLF", async () => {
  const { root, base } = await fixture();
  const unchanged = await check(root, { base });
  expect(unchanged.ok).toBe(true);
  expect(unchanged.legacy.some((item: { file: string }) => item.file === "apps/test/old.ts")).toBe(
    true,
  );
  write(root, "apps/test/old.ts", "// Added context.\r\nexport const oldValue: any = 1;\r\n");
  expect((await check(root, { base })).ok).toBe(true);
});
it("rejects changed debt and same-count replacement rather than netting counts", async () => {
  const { root, base } = await fixture();
  write(root, "apps/test/old.ts", "export const replacement: any = 2;\n");
  const result = await check(root, { base });
  expect(result.ok).toBe(false);
  expect(
    result.findings.some(
      (item: { rule: string }) => item.rule === "@typescript-eslint/no-explicit-any",
    ),
  ).toBe(true);
});
it("treats renames and copied files as new strict files", async () => {
  const { root, base } = await fixture();
  fs.renameSync(path.join(root, "apps/test/old.ts"), path.join(root, "apps/test/renamed.ts"));
  const result = await check(root, { base });
  expect(result.ok).toBe(false);
  expect(result.findings.some((item: { file: string }) => item.file.endsWith("renamed.ts"))).toBe(
    true,
  );
});
it("refuses deletion/reordering ambiguity even if a diff would anchor the moved debt", async () => {
  const before = "export const head = 0;\nexport const debt: any = 1;\nexport const tail = 2;\n";
  const { root, base } = await fixture(before);
  write(
    root,
    "apps/test/old.ts",
    "export const debt: any = 1;\nexport const tail = 2;\nexport const head = 0;\n",
  );
  expect((await check(root, { base })).ok).toBe(false);
});
it("allows old formatting only at unchanged mapped spans and rejects new malformed formatting", async () => {
  const { root, base } = await fixture("export const  oldValue=1\n");
  expect((await check(root, { base, mode: "format" })).ok).toBe(true);
  write(root, "apps/test/new.ts", "export const  newer=2\n");
  expect(
    (await check(root, { base, mode: "format" })).findings.some(
      (item: { kind: string }) => item.kind === "format",
    ),
  ).toBe(true);
});
it("fails closed on syntax errors and missing or invalid trusted bases", async () => {
  const { root, base } = await fixture();
  await expect(check(root)).rejects.toThrow(/trusted/);
  await expect(check(root, { base: "does-not-exist" })).rejects.toThrow();
  write(root, "apps/test/new.ts", "export const = ;\n");
  await expect(check(root, { base })).rejects.toThrow();
});
it("rejects baseline allowance injection and executable config changes before loading config", async () => {
  const { root, base } = await fixture();
  const baseline = fs.readFileSync(path.join(root, BASELINE), "utf8");
  const enlarged = JSON.parse(baseline);
  enlarged.files["apps/test/new.ts"] = enlarged.files["apps/test/old.ts"];
  write(root, BASELINE, JSON.stringify(enlarged));
  await expect(check(root, { base })).rejects.toThrow(/expanded/);
  write(root, BASELINE, baseline);
  write(root, "prettier.config.mjs", 'throw new Error("config executed");\n');
  await expect(check(root, { base })).rejects.toThrow(/configuration/);
});
it("cannot use a newly generated baseline as its own approval and refuses in-place bootstrap", async () => {
  const { root, original } = await fixture();
  await expect(check(root, { base: original })).rejects.toThrow(/separate review/);
  await expect(main([`--bootstrap=${original}`, `--output=${BASELINE}`], root)).rejects.toThrow(
    /overwrite/,
  );
});
it("blocks new suppression comments even if the underlying code is otherwise clean", async () => {
  const { root, base } = await fixture();
  write(
    root,
    "apps/test/new.ts",
    "// eslint-disable-next-line no-unused-vars\nexport const valid = 1;\n",
  );
  const result = await check(root, { base });
  expect(result.ok).toBe(false);
  expect(result.findings.some((item: { kind: string }) => item.kind === "suppression")).toBe(true);
});
it("reduces allowances after a fix and does not permit reintroduction", async () => {
  const { root, base } = await fixture();
  write(root, "apps/test/old.ts", "export const oldValue: number = 1;\n");
  expect((await check(root, { base, reduce: true })).ok).toBe(true);
  write(root, "apps/test/old.ts", "export const oldValue: any = 1;\n");
  expect((await check(root, { base })).ok).toBe(false);
});
it("requires every line of a multiline issue to remain unchanged", () => {
  const before = "start\nline A\nline B\nend\n";
  const issue = {
    kind: "format",
    rule: "prettier",
    line: 2,
    endLine: 3,
    column: 1,
    endColumn: 1,
    fingerprint: sha256("multiline"),
  };
  expect(allowedIssues(before, before, [issue], [issue]).blocked).toEqual([]);
  expect(allowedIssues(before, "start\nline A\nchanged\nend\n", [issue], [issue]).blocked).toEqual([
    issue,
  ]);
});

it("checks the precise tool engine floor without changing application engines", () => {
  for (const version of ["18.20.0", "20.0.0", "20.8.9", "21.0.0"])
    expect(supportedRuntime(version)).toBe(false);
  for (const version of ["20.9.0", "20.19.0", "21.1.0", "22.0.0", "24.18.0"])
    expect(supportedRuntime(version)).toBe(true);
});

it("previews a candidate as untrusted and rejects fabricated or missing allowances", async () => {
  const { root, original } = await fixture();
  const candidate = await bootstrap(root, original);
  const file = path.join(root, "candidate.json");
  fs.writeFileSync(file, JSON.stringify(candidate));
  // Keep the review artifact outside the checked source scope.
  const outside = path.join(root, ".git", "candidate.json");
  fs.renameSync(file, outside);
  const result = await main([`--preview=${outside}`], root);
  expect(result).toMatchObject({ ok: true, trusted: false, review: "pending" });
  delete candidate.files["apps/test/old.ts"];
  fs.writeFileSync(outside, JSON.stringify(candidate));
  await expect(main([`--preview=${outside}`], root)).rejects.toThrow(/independently measured/);
  write(root, "scripts/quality-new.ts", "export const bad: any = 1;\n");
  fs.writeFileSync(outside, JSON.stringify(await bootstrap(root, original)));
  expect(await main([`--preview=${outside}`], root)).toMatchObject({ ok: false, trusted: false });
});

it("checks module-flavoured TS declarations rather than silently ignoring them", async () => {
  const { root, base } = await fixture();
  write(root, "apps/test/new.d.mts", "export declare const value: any;\n");
  const result = await check(root, { base });
  expect(result.ok).toBe(false);
  expect(
    result.findings.some(
      (issue: { rule: string }) => issue.rule === "@typescript-eslint/no-explicit-any",
    ),
  ).toBe(true);
});

it("rejects changes to each implementation file after trusting a baseline", async () => {
  const { root, base } = await fixture();
  for (const file of IMPLEMENTATION_FILES) {
    const original = fs.readFileSync(path.join(root, file), "utf8");
    write(root, file, original + "\n// altered gate implementation\n");
    await expect(check(root, { base })).rejects.toThrow(/configuration/);
    write(root, file, original);
  }
  expect((await check(root, { base })).ok).toBe(true);
});
