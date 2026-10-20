import { parseProject, type SceneScriptProject } from "@glintai/scenescript";
import { ComposerError } from "./errors";
import { parseMarkdown, detectLanguage, content, narration } from "./parsing";
import { buildSectionScenes } from "./strategies";
import { isTemplateId, THEME_IDS, type TemplateId } from "./templates";
export { ComposerError };
export interface ComposerOptions {
  projectId?: string; title?: string; language?: string; theme?: string; fps?: number;
  aspect?: "16:9" | "9:16" | "1:1"; maxScenes?: number; template?: TemplateId; sourceName?: string; useLlm?: boolean;
}
export function validateComposerOptions(options: ComposerOptions): void {
  if (options.maxScenes !== undefined && (!Number.isInteger(options.maxScenes) || options.maxScenes < 1 || options.maxScenes > 100)) throw new ComposerError("maxScenes must be 1..100");
  if (options.template !== undefined && !isTemplateId(options.template)) throw new ComposerError("Unknown template");
  if (options.theme !== undefined && !(THEME_IDS as readonly string[]).includes(options.theme)) throw new ComposerError("Unknown theme");
  if (options.aspect !== undefined && !["16:9", "9:16", "1:1"].includes(options.aspect)) throw new ComposerError("Invalid aspect");
  if (options.fps !== undefined && (!Number.isInteger(options.fps) || options.fps < 24 || options.fps > 60)) throw new ComposerError("fps must be 24..60");
}
export function composeFromMarkdown(markdown: string, options: ComposerOptions = {}): SceneScriptProject {
  validateComposerOptions(options);
  const { title, sections } = parseMarkdown(markdown, options.title);
  if (!title || !sections.length) throw new ComposerError("Source document has no body; nothing to compose.");
  const max = options.maxScenes ?? 8;
  const first = content(sections[0]!)[0];
  return parseProject({
    schemaVersion: 1, id: options.projectId ?? "composed", title,
    language: options.language ?? detectLanguage(markdown), aspect: options.aspect ?? "16:9", fps: options.fps ?? 30,
    theme: options.theme ?? "glint-dark",
    knowledgeSources: [{ id: "source", kind: "markdown", name: options.sourceName ?? "source.md" }],
    scenes: [{ id: "intro", kind: "title", title,
      ...(first && first !== title ? { subtitle: first.slice(0, 48) } : {}),
      narration: { text: narration([title, first ?? ""]) } },
      ...buildSectionScenes(sections, options.template ?? "explainer", max - 1, title)],
  });
}
