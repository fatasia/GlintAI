import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

export const normalize = (text) => text.replace(/\r\n/g, "\n");
export const sha256 = (text) => createHash("sha256").update(text).digest("hex");
export function git(root, args) {
  return execFileSync("git", ["--no-pager", ...args], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
}
export function sourceAt(root, commit, file) {
  return normalize(git(root, ["show", `${commit}:${file}`]));
}
export function commitId(root, ref) {
  if (!/^[a-zA-Z0-9_./-]+$/.test(ref) || ref.startsWith("-"))
    throw new Error("Invalid trusted base");
  return git(root, ["rev-parse", "--verify", `${ref}^{commit}`]).trim();
}
export function diffHunks(before, after) {
  if (before === after) return [];
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "glint-quality-diff-"));
  if (!path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep))
    throw new Error("Invalid temporary path");
  try {
    const a = path.join(temp, "before"),
      b = path.join(temp, "after");
    fs.writeFileSync(a, before);
    fs.writeFileSync(b, after);
    const result = spawnSync(
      "git",
      [
        "--no-pager",
        "diff",
        "--no-index",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--diff-algorithm=myers",
        "--unified=0",
        "--",
        a,
        b,
      ],
      { encoding: "utf8", maxBuffer: 128 * 1024 * 1024, windowsHide: true },
    );
    if (result.error || ![0, 1].includes(result.status))
      throw new Error("Unable to map source differences");
    const hunks = [...result.stdout.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map(
      (m) => ({
        oldStart: Number(m[1]),
        oldCount: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newCount: m[4] === undefined ? 1 : Number(m[4]),
      }),
    );
    if (!hunks.length) throw new Error("Changed source has no reliable text mapping");
    return hunks;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

const meaningfulLine = (line) => {
  const key = line.trim().replace(/\s+/g, " ");
  return /[\p{L}\p{N}_$]/u.test(key) ? key : "";
};
function lineCounts(lines) {
  const counts = new Map();
  for (const line of lines) {
    const key = meaningfulLine(line);
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
function movementRisk(hunks, oldLines, newLines) {
  const blocks = hunks.map((h) => ({
    old: oldLines
      .slice(h.oldStart - 1, h.oldStart - 1 + h.oldCount)
      .map(meaningfulLine)
      .filter(Boolean),
    next: newLines
      .slice(h.newStart - 1, h.newStart - 1 + h.newCount)
      .map(meaningfulLine)
      .filter(Boolean),
  }));
  for (const [index, block] of blocks.entries()) {
    for (const [otherIndex, other] of blocks.entries()) {
      // An independent removal/addition may be a rewritten move; do not infer intent.
      if (
        index !== otherIndex &&
        block.old.length &&
        other.next.length &&
        (!block.next.length || !other.old.length)
      )
        return true;
      for (const [position, key] of block.old.entries()) {
        if (
          other.next.some(
            (value, nextPosition) =>
              value === key && (index !== otherIndex || position !== nextPosition),
          )
        )
          return true;
      }
    }
  }
  return false;
}
/** Map only unchanged blocks; shifted blocks require a unique unchanged content anchor. */
export function lineMap(before, after) {
  const hunks = diffHunks(before, after),
    map = new Map();
  const oldLines = before.split("\n"),
    newLines = after.split("\n");
  const moved = movementRisk(hunks, oldLines, newLines);
  const oldCounts = lineCounts(oldLines),
    newCounts = lineCounts(newLines);
  const addBlock = (oldStart, newStart, length) => {
    const same = Array.from(
      { length },
      (_, index) => oldLines[oldStart + index] === newLines[newStart + index],
    ).every(Boolean);
    if (!same) return;
    const anchored = oldLines.slice(oldStart, oldStart + length).some((line) => {
      const key = meaningfulLine(line);
      return key && oldCounts.get(key) === 1 && newCounts.get(key) === 1;
    });
    if (oldStart !== newStart && (moved || !anchored)) return;
    for (let index = 0; index < length; index++)
      map.set(newStart + index + 1, oldStart + index + 1);
  };
  let oldStart = 0,
    newStart = 0;
  for (const h of hunks) {
    const oldBoundary = h.oldCount ? h.oldStart - 1 : h.oldStart;
    const newBoundary = h.newCount ? h.newStart - 1 : h.newStart;
    addBlock(oldStart, newStart, Math.min(oldBoundary - oldStart, newBoundary - newStart));
    oldStart = oldBoundary + h.oldCount;
    newStart = newBoundary + h.newCount;
  }
  addBlock(oldStart, newStart, Math.min(oldLines.length - oldStart, newLines.length - newStart));
  return map;
}
export function issueKey(issue) {
  return JSON.stringify([
    issue.kind,
    issue.rule,
    issue.fingerprint,
    issue.line,
    issue.endLine,
    issue.column,
    issue.endColumn,
  ]);
}
export function allowedIssues(before, after, baseline, current) {
  const map = lineMap(before, after),
    remaining = new Map(baseline.map((issue) => [issueKey(issue), issue]));
  const blocked = [],
    retained = [];
  for (const issue of current) {
    const start = map.get(issue.line),
      end = map.get(issue.endLine);
    const contiguous =
      start !== undefined &&
      end !== undefined &&
      end - start === issue.endLine - issue.line &&
      Array.from(
        { length: issue.endLine - issue.line + 1 },
        (_, i) => map.get(issue.line + i) === start + i,
      ).every(Boolean);
    const key = contiguous ? issueKey({ ...issue, line: start, endLine: end }) : "";
    if (remaining.has(key)) {
      retained.push(remaining.get(key));
      remaining.delete(key);
    } else blocked.push(issue);
  }
  return { blocked, retained };
}
