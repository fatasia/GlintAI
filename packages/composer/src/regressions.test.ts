import { describe, expect, it } from "vitest";
import { composeFromMarkdown } from "./heuristic";
import { composeWithLlm } from "./llm";
import { MockLlmProvider } from "@glintai/llm";
import { splitSentences } from "./parsing";
const base = '# Topic\n## Same\n- First item\n- Second item\n## Same\n- Another item\n- Last item';
describe("composer regressions", () => {
  it("handles list-only input and duplicate headings with nonempty unique scenes", () => {
    const project = composeFromMarkdown(base);
    expect(new Set(project.scenes.map((s) => s.id)).size).toBe(project.scenes.length);
    expect(project.scenes.every((s) => s.narration.text.trim().length)).toBe(true);
    expect(composeFromMarkdown('- A\n- B').scenes.length).toBeGreaterThan(1);
  });
  it("splits English sentences but not decimal numbers", () => {
    expect(splitSentences('Rate is 3.5 percent. Save the result. Try again!')).toEqual(['Rate is 3.5 percent.', 'Save the result.', 'Try again!']);
    expect(splitSentences('first sentence. second sentence.')).toEqual(['first sentence.', 'second sentence.']);
  });
  it("retains multiple code blocks and respects the opening fence length", () => {
    const project = composeFromMarkdown('# Code\n## Examples\n````md\n```ts\nconst a = 1;\n```\n````\n\n```c++\nint b = 2;\n```', { template: 'code-walkthrough' });
    const code = project.scenes.filter((scene) => scene.kind === 'code');
    expect(code).toHaveLength(2);
    expect(code[0]!.code).toContain('```ts');
    expect(code[1]!.language).toBe('c++');
  });
  it.each(["explainer", "listicle", "versus", "recap"] as const)("honors maxScenes=1 for %s", (template) => {
    expect(composeFromMarkdown(base, { template, maxScenes: 1 }).scenes).toHaveLength(1);
  });
  it.each([0, -1, 1.5, NaN, 101])("rejects invalid maxScenes %s", (maxScenes) => {
    expect(() => composeFromMarkdown(base, { maxScenes })).toThrow(/maxScenes/);
  });
  it("does not label arbitrary source as research results", () => {
    expect(() => composeFromMarkdown(base, { template: "paper" })).toThrow(/prerequisites/);
  });
  const cases = [
    ['howto', '# Steps\n## Prepare\nOpen the file.\n## Run\nExecute the command.', 'diagram'],
    ['timeline', '# History\n## 2020\nProject started.\n## 2024\nProject shipped.', 'diagram'],
    ['faq', '# Questions\n## Why cache?\nIt avoids repeated work.', 'definition'],
    ['mythfact', '# Cache\n## Myth\nAll caches persist.\n## Fact\nMemory caches can be volatile.', 'comparison'],
    ['case-study', '# Case\n## Context\nRequests repeated.\n## Action\nCache was added.\n## Result\nFewer requests repeated.', 'diagram'],
    ['problem-solution', '# Latency\n## Problem\nRequests repeated.\n## Solution\nCache results.', 'comparison'],
    ['code-walkthrough', '# Code\n## Entry\nRuns a function.\n```ts\nexport const x = 1;\n```', 'code'],
    ['recap', base, 'bullets'],
  ] as const;
  it.each(cases)("implements %s with its required structure", (template, source, kind) => {
    const p = composeFromMarkdown(source, { template });
    expect(p.scenes.slice(1).some((s) => s.kind === kind)).toBe(true);
    expect(composeFromMarkdown(source, { template, maxScenes: 1 }).scenes).toHaveLength(1);
  });
  it.each(['howto', 'timeline', 'faq', 'mythfact', 'case-study', 'problem-solution', 'code-walkthrough'] as const)("rejects unmet prerequisites for %s", (template) => {
    expect(() => composeFromMarkdown('# Plain\nJust a paragraph.', { template })).toThrow(/prerequisites/);
  });
  it("pins output options and caps model scene count", async () => {
    const llm = new MockLlmProvider(() => JSON.stringify({ schemaVersion: 1, id: 'model', title: 'model', aspect: '16:9', scenes: [1,2,3].map((n) => ({id:`scene-${n}`,kind:'title',title:'model',narration:{text:'Body.'}})) }));
    const p = await composeWithLlm(base, llm, { title: 'Pinned', aspect: '9:16', theme: 'mint-clean', fps: 24, maxScenes: 1 });
    expect(p).toMatchObject({ title: 'Pinned', aspect: '9:16', theme: 'mint-clean', fps: 24 });
    expect(p.scenes).toHaveLength(1);
  });
  it("rejects model replies that violate a template contract", async () => {
    const llm = new MockLlmProvider(() => JSON.stringify({schemaVersion:1,id:'x',title:'X',aspect:'16:9',scenes:[{id:'intro',kind:'title',title:'X',narration:{text:'X'}}]}));
    await expect(composeWithLlm(base, llm, {template:'versus'})).rejects.toThrow(/requires comparison/);
  });
});
