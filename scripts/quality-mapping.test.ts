import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { allowedIssues, git, normalize, sha256, sourceAt } from "./quality-git.mjs";
import { createAnalyzer } from "./quality-analyzer.mjs";
const issue = (line: number, text = "consume(debt);", endLine = line) => ({
  kind: "lint",
  rule: "fixture-rule",
  line,
  endLine,
  column: 1,
  endColumn: 2,
  fingerprint: sha256(text),
});
it("retains unchanged debt after replacing an unrelated line and inserting a blank line", () => {
  const before = "const lead = 1;\nconsume(debt);\n";
  const after = "const lead = 2;\n\nconsume(debt);\n";
  expect(allowedIssues(before, after, [issue(2)], [issue(3)]).blocked).toEqual([]);
});
it("retains actual analyzer diagnostics in the existing large server after upstream replacement and blank insertion", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  // The analyzer property must hold for any large historical revision of the
  // server file; resolve the newest one instead of pinning a single repo's
  // hash (private and public histories graft to different commit ids).
  const file = "apps/web/server/index.mjs";
  const history = git(root, ["log", "--format=%H", "--", file]).trim().split("\n");
  const anchor = history.find(id => sourceAt(root, id, file).split("\n").length > 1000)!;
  const before = sourceAt(root, anchor, file);
  expect(before.split("\n").length).toBeGreaterThan(1000);
  // The unrelated-line edit targets whatever line currently carries the http
  // import; its exact position drifted across eras of the server file.
  const lines = before.split("\n");
  const importLine = lines.findIndex(line => line === 'import http from "node:http";');
  expect(importLine).toBeGreaterThanOrEqual(0);
  lines[importLine] = 'import http from "http";';
  const after = lines.join("\n");
  const analyze = await createAnalyzer(root),
    previous = await analyze(file, before),
    current = await analyze(file, after);
  expect(previous.length).toBeGreaterThan(100);
  expect(allowedIssues(before, after, previous, current).blocked).toEqual([]);
  expect(allowedIssues(before, after, previous, current).retained).toHaveLength(previous.length);
});
it("rejects relocated code even when Git anchors the untouched debt block", () => {
  const before = "const head = 1;\nconsume(debt);\nconst tail = 2;\n";
  for (const after of [
    "consume(debt);\nconst tail = 2;\nconst head = 1;\n",
    "consume(debt);\nconst tail = 2;\n  const head = 1;\n",
    "consume(debt);\nconst tail = 2;\nconst renamedHead = 3;\n",
  ])
    expect(allowedIssues(before, after, [issue(2)], [issue(1)]).blocked).toHaveLength(1);
});
it("rejects shifted duplicate context without an independently unique unchanged anchor", () => {
  const before = "const head = 1;\nconsume(debt);\nconsume(debt);\n";
  const after = "const head = 2;\n\nconsume(debt);\nconsume(debt);\n";
  expect(
    allowedIssues(before, after, [issue(2), issue(3)], [issue(3), issue(4)]).blocked,
  ).toHaveLength(2);
});
it("does not transfer a single allowance to an additional copy", () => {
  const before = "consume(debt);\nconst tail = 2;\n";
  const after = "consume(debt);\nconsume(debt);\nconst tail = 2;\n";
  const result = allowedIssues(before, after, [issue(1)], [issue(1), issue(2)]);
  expect(result.blocked.length).toBeGreaterThan(0);
  expect(result.retained.length).toBeLessThanOrEqual(1);
});
it("refuses a touched interior line of a multiline diagnostic after a valid upstream shift", () => {
  const before = "const head = 1;\nconsume(debt);\nconsume(other);\n";
  const after = "const head = 2;\n\nconsume(debt);\nconsume(changed);\n";
  expect(
    allowedIssues(before, after, [issue(2, "span", 3)], [issue(3, "span", 4)]).blocked,
  ).toHaveLength(1);
});
it("maps normalized CRLF and rejects two distinct removed/added code blocks conservatively", () => {
  const before = "const head = 1;\nconsume(debt);\n";
  const after = "const head = 2;\r\n\r\nconsume(debt);\r\n";
  expect(allowedIssues(before, normalize(after), [issue(2)], [issue(3)]).blocked).toEqual([]);
  expect(
    allowedIssues(before, "consume(debt);\nconst unrelated = 3;\n", [issue(2)], [issue(1)]).blocked,
  ).toHaveLength(1);
});
