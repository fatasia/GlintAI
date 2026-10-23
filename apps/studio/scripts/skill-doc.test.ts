import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const skillPath = fileURLToPath(new URL("../../../skills/glint-video/SKILL.md", import.meta.url));
const cliPath = fileURLToPath(new URL("./glint.ts", import.meta.url));

/** Keeps the Skill honest: every command it teaches must exist in this CLI. */
describe("glint-video skill document", () => {
  const skill = readFileSync(skillPath, "utf8");
  const cli = readFileSync(cliPath, "utf8");

  it("has parseable frontmatter with a discoverable name and bounded description", () => {
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skill);
    expect(match, "frontmatter").not.toBeNull();
    const fields = Object.fromEntries(match![1]!.split(/\r?\n/).map(line => {
      const separator = line.indexOf(":");
      return separator > 0 ? [line.slice(0, separator).trim(), line.slice(separator + 1).trim()] : [line, ""];
    }));
    expect(fields.name).toBe("glint-video");
    const description = fields.description ?? "";
    expect(description.length).toBeGreaterThan(20);
    expect(description.length).toBeLessThanOrEqual(1024);
  });

  it("only documents commands this CLI actually implements", () => {
    const implemented = new Set([...cli.matchAll(/case "([a-z-]+)"/g)].map(match => match[1]!));
    const documented = new Set([...skill.matchAll(/pnpm glint ([a-z-]+)/g)].map(match => match[1]!));
    expect(documented.size).toBeGreaterThan(8);
    expect([...documented].filter(command => !implemented.has(command))).toEqual([]);
  });

  it("promises a direct path and avoids unverifiable claims", () => {
    expect(skill).toContain("pnpm glint quick");
    expect(skill).toContain("--text=");
    const overclaims = skill.split(/\r?\n/).filter(line => /全面超越|全端实测|最高审美|100% ?完美/.test(line));
    // The only allowed mentions are explicit prohibitions ("不用…类断言").
    expect(overclaims.every(line => line.includes("不用"))).toBe(true);
    // Legacy compatibility must stay explicitly marked, not sold as a delivery path.
    expect(skill).toMatch(/弃用|实验/);
  });
});
