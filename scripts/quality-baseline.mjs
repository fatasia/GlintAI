import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { CONFIG_FILES, TOOLCHAIN, BASELINE } from "./quality-analyzer.mjs";
import { git, normalize, sha256, issueKey } from "./quality-git.mjs";

export const IMPLEMENTATION_FILES = [
  "scripts/check-code-quality.mjs",
  "scripts/quality-git.mjs",
  "scripts/quality-baseline.mjs",
  "scripts/quality-analyzer.mjs",
];
export function policy(root) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const require = createRequire(path.join(root, "package.json"));
  for (const [name, version] of Object.entries(TOOLCHAIN)) {
    if (
      pkg.devDependencies?.[name] !== version ||
      require(`${name}/package.json`).version !== version
    )
      throw new Error(`Toolchain mismatch: ${name} must be ${version}`);
  }
  return sha256(
    JSON.stringify(
      [...CONFIG_FILES, ...IMPLEMENTATION_FILES]
        .map((file) => [file, normalize(fs.readFileSync(path.join(root, file), "utf8"))])
        .concat([["toolchain", JSON.stringify(TOOLCHAIN)]]),
    ),
  );
}
export function parseBaseline(text) {
  const data = JSON.parse(text);
  if (
    !data ||
    data.version !== 1 ||
    !/^[a-f0-9]{40}$/.test(data.source) ||
    !/^[a-f0-9]{64}$/.test(data.policy) ||
    !data.files ||
    typeof data.files !== "object" ||
    Array.isArray(data.files)
  )
    throw new Error("Invalid quality baseline");
  if (
    Object.keys(data).some(
      (key) => !["version", "source", "policy", "files", "review"].includes(key),
    )
  )
    throw new Error("Unexpected baseline field");
  for (const [file, entry] of Object.entries(data.files)) {
    if (
      !file ||
      file.includes("\\") ||
      file.startsWith("/") ||
      file.split("/").some((part) => !part || part === ".." || part === ".") ||
      /[:\0\r\n]/.test(file)
    )
      throw new Error("Invalid baseline path");
    if (
      !entry ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      !Array.isArray(entry.issues) ||
      !Number.isSafeInteger(entry.originalCount) ||
      entry.originalCount < entry.issues.length ||
      Object.keys(entry).some((key) => !["sha256", "originalCount", "issues"].includes(key))
    )
      throw new Error("Invalid baseline file");
    const keys = new Set();
    for (const issue of entry.issues) {
      if (
        !["lint", "format", "suppression"].includes(issue.kind) ||
        typeof issue.rule !== "string" ||
        !issue.rule ||
        !/^[a-f0-9]{64}$/.test(issue.fingerprint) ||
        ["line", "endLine", "column", "endColumn"].some(
          (key) => !Number.isSafeInteger(issue[key]) || issue[key] < 1,
        ) ||
        issue.endLine < issue.line ||
        Object.keys(issue).some(
          (key) =>
            !["kind", "rule", "fingerprint", "line", "endLine", "column", "endColumn"].includes(
              key,
            ),
        )
      )
        throw new Error("Invalid baseline issue");
      const key = issueKey(issue);
      if (keys.has(key)) throw new Error("Duplicate baseline issue");
      keys.add(key);
    }
  }
  return data;
}
export function trustedBaseline(root, base, expectedPolicy) {
  let trusted;
  try {
    trusted = parseBaseline(git(root, ["show", `${base}:${BASELINE}`]));
  } catch {
    throw new Error(
      "Trusted base has no valid quality baseline; bootstrap requires separate review",
    );
  }
  const working = parseBaseline(fs.readFileSync(path.join(root, BASELINE), "utf8"));
  if (
    trusted.policy !== expectedPolicy ||
    working.policy !== trusted.policy ||
    working.source !== trusted.source
  )
    throw new Error("Quality configuration or baseline source changed; explicit review required");
  git(root, ["merge-base", "--is-ancestor", trusted.source, base]);
  for (const [file, entry] of Object.entries(working.files)) {
    const prior = trusted.files[file];
    if (!prior || prior.sha256 !== entry.sha256 || prior.originalCount !== entry.originalCount)
      throw new Error(`Baseline expanded or changed: ${file}`);
    const allowed = new Set(prior.issues.map(issueKey));
    if (entry.issues.some((issue) => !allowed.has(issueKey(issue))))
      throw new Error(`Baseline allowance increased: ${file}`);
  }
  return working;
}
