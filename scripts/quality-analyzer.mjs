import { ESLint } from "eslint";
import tseslint from "typescript-eslint";
import * as prettier from "prettier";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { diffHunks, sha256 } from "./quality-git.mjs";

export const CONFIG_FILES = ["eslint.config.mjs", "prettier.config.mjs"];
export const BASELINE = "scripts/code-quality-baseline.json";
export const TOOLCHAIN = {
  eslint: "9.39.1",
  "@eslint/js": "9.39.1",
  "typescript-eslint": "8.46.4",
  prettier: "3.6.2",
};
export const strictOnly = (file) =>
  /^(?:eslint|prettier)\.config\.mjs$|^scripts\/(?:check-code-quality|quality-).*\.(?:mjs|ts)$/.test(
    file,
  );
export function inScope(file) {
  if (
    file === BASELINE ||
    file === "pnpm-lock.yaml" ||
    /(^|\/)(?:node_modules[^/]*|dist|target|coverage|\.git|evidence|public|assets|fixtures)(\/|$)/.test(
      file,
    )
  )
    return false;
  return (
    /^(?:apps|packages|scripts)\/.*\.(?:[cm]?[jt]sx?|css|json)$/.test(file) ||
    /^[^/]+\.(?:json|ya?ml|[cm]?js)$/.test(file) ||
    /^\.github\/workflows\/.*\.ya?ml$/.test(file)
  );
}
function lintIssues(file, source, messages) {
  const issues = [];
  for (const message of messages) {
    if (!message.ruleId && !message.fatal && message.message.includes("has no effect")) continue;
    if (message.fatal || !message.ruleId)
      throw new Error(`${file}:${message.line ?? 1}: ${message.message}`);
    issues.push({
      kind: "lint",
      rule: message.ruleId,
      line: message.line,
      endLine: message.endLine ?? message.line,
      column: message.column,
      endColumn: message.endColumn ?? message.column,
      fingerprint: sha256(
        `${message.messageId ?? message.message}\0${source
          .split("\n")
          .slice(message.line - 1, message.endLine ?? message.line)
          .join("\n")}`,
      ),
    });
  }
  return issues;
}
function suppressionIssues(comments) {
  const issues = [];
  for (const comment of comments) {
    if (
      /eslint-(?:disable|enable)|prettier-ignore|@ts-(?:ignore|nocheck|expect-error)/.test(
        comment.value,
      )
    ) {
      issues.push({
        kind: "suppression",
        rule: "no-new-suppression",
        line: comment.loc.start.line,
        endLine: comment.loc.end.line,
        column: comment.loc.start.column + 1,
        endColumn: comment.loc.end.column + 1,
        fingerprint: sha256(comment.value),
      });
    }
  }
  return issues;
}
function formatIssues(comparable, formatted) {
  const issues = [];
  const oldLines = comparable.split("\n"),
    newLines = formatted.split("\n");
  for (const h of diffHunks(comparable, formatted)) {
    const line = Math.max(1, h.oldStart),
      endLine = Math.max(line, h.oldStart + h.oldCount - 1);
    const before = oldLines.slice(h.oldStart - 1, h.oldStart - 1 + h.oldCount).join("\n");
    const after = newLines.slice(h.newStart - 1, h.newStart - 1 + h.newCount).join("\n");
    issues.push({
      kind: "format",
      rule: "prettier",
      line,
      endLine,
      column: 1,
      endColumn: 1,
      fingerprint: sha256(`${before}\0${after}`),
    });
  }
  return issues;
}
export async function createAnalyzer(root) {
  const eslint = new ESLint({
    cwd: root,
    overrideConfigFile: path.join(root, "eslint.config.mjs"),
    allowInlineConfig: false,
    ignore: false,
  });
  const options = (await import(pathToFileURL(path.join(root, "prettier.config.mjs")).href))
    .default;
  return async (file, source) => {
    const isCode = /\.[cm]?[jt]sx?$/.test(file);
    const [result] = isCode
      ? await eslint.lintText(source, {
          filePath: path.join(root, file),
          warnIgnored: true,
        })
      : [{ messages: [] }];
    const lint = lintIssues(file, source, result.messages);
    const comments = isCode
      ? (tseslint.parser.parseForESLint(source, {
          comment: true,
          tsconfigRootDir: root,
          filePath: path.join(root, file),
          loc: true,
          ecmaVersion: "latest",
          sourceType: file.endsWith(".cjs") ? "script" : "module",
          ecmaFeatures: { jsx: true },
        }).ast.comments ?? [])
      : [];
    // Neutralize formatter directives: legacy comments must not hide newly changed code.
    const comparable = source.replaceAll("prettier-ignore", "format-legacy-note");
    const formatted = await prettier.format(comparable, {
      ...options,
      filepath: path.join(root, file),
    });
    return [...lint, ...suppressionIssues(comments), ...formatIssues(comparable, formatted)];
  };
}
