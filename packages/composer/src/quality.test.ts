import { describe, expect, it } from "vitest";
import { composeFromMarkdown } from "./heuristic";
import { reviewProject } from "./quality";

function review(text: string, source: string) {
  const project = composeFromMarkdown("# Test\n\nA useful source sentence.");
  project.scenes = [project.scenes[0]!];
  project.scenes[0]!.narration.text = text;
  return reviewProject(project, source).sentences[0]!;
}
describe("lexical evidence review", () => {
  it("returns source offsets rather than claiming a truth verdict", () => {
    const sentence = review("Water boils at 100 degrees.", "Intro. Water boils at 100 degrees.");
    expect(sentence.flags).toEqual([]);
    const candidate = sentence.candidates[0]!;
    expect(candidate.start).toBe(7);
    expect(candidate.end).toBe(34);
    expect(candidate.score).toBe(1);
  });
  it("flags changed numbers despite high lexical similarity", () => {
    expect(review("Water boils at 900 degrees.", "Water boils at 100 degrees.").flags).toContain("number-mismatch");
  });
  it("flags reversed negation in English and Chinese", () => {
    expect(review("This treatment is effective.", "This treatment is not effective.").flags).toContain("negation-mismatch");
    expect(review("该方法提高学习效率。", "该方法不能提高学习效率。").flags).toContain("negation-mismatch");
  });
  it("flags unmatched claims and repetitions", () => {
    expect(review("Galaxies contain stars.", "Water boils.").flags).toContain("no-candidate");
    const project = composeFromMarkdown("# Test\n\nWater boils. Water boils.");
    const report = reviewProject(project, "Water boils.");
    expect(report.sentences.some((sentence) => sentence.flags.includes("repeated"))).toBe(true);
  });
});
