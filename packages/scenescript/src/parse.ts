import type { ZodError } from "zod";
import { SceneScriptProject, type SceneScriptProject as Project } from "./types";

export class SceneScriptParseError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(
      `Invalid SceneScript project (schemaVersion 1):\n  - ${issues.join("\n  - ")}`,
    );
    this.name = "SceneScriptParseError";
    this.issues = issues;
  }
}

export function formatIssues(error: ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message}`;
  });
}

export type ParseResult =
  | { ok: true; project: Project }
  | { ok: false; issues: string[] };

export function safeParseProject(input: unknown): ParseResult {
  const result = SceneScriptProject.safeParse(input);
  if (result.success) return { ok: true, project: result.data };
  return { ok: false, issues: formatIssues(result.error) };
}

export function parseProject(input: unknown): Project {
  const result = safeParseProject(input);
  if (!result.ok) throw new SceneScriptParseError(result.issues);
  return result.project;
}
