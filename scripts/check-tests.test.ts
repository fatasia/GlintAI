import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseReasons, resolveBase, run } from "./check-tests.mjs";

let repo = "";
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const write = (file: string, text: string) => {
  const full = path.join(repo, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
};
const commit = (message: string) => { git("add", "-A"); git("commit", "-q", "-m", message); };
const guard = (...args: string[]) => run(["--base", "main", ...args], repo);
const rules = (result: { findings: { rule: string; waived?: string }[] }) => result.findings.filter(item => !item.waived).map(item => item.rule).sort();

const GOOD = `import { it, expect } from "vitest";
it("adds", () => {
  expect(1 + 1).toBe(2);
  expect(2 + 2).toBe(4);
  expect(3 + 3).toBe(6);
});
`;

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(process.env.TEMP ?? os.tmpdir(), "check-tests-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "guard@example.test");
  git("config", "user.name", "Guard");
  git("config", "core.autocrlf", "false");
  write("src/a.test.ts", GOOD);
  write("vitest.config.ts", "export default { test: { testTimeout: 30000 } };\n");
  write("src/__snapshots__/a.snap", "snap v1\n");
  write("src/golden/frame.txt", "golden v1\n");
  write("tool.ts", "export const x = 1;\n");
  commit("base");
  git("switch", "-q", "-c", "work");
});

afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

describe("rules", () => {
  it("AC1/T1: reports a new it.skip with file and line, exit code 1", () => {
    write("src/a.test.ts", `${GOOD}it.skip("later", () => { expect(1).toBe(1); });\n`);
    commit("skip");
    const result = guard();
    expect(result.exitCode).toBe(1);
    expect(result.findings).toMatchObject([{ rule: "T1", file: "src/a.test.ts", line: 7 }]);
    expect(result.lines[0]).toContain("T1 src/a.test.ts:7");
  });

  it("T1 ignores skips that already existed on the base", () => {
    write("src/b.test.ts", `import { it, expect } from "vitest";\nit.skip("old", () => { expect(1).toBe(1); });\n`);
    commit("old skip on work");
    git("switch", "-q", "main"); git("merge", "-q", "work"); git("switch", "-q", "work");
    write("tool.ts", "export const x = 2;\n");
    commit("unrelated");
    expect(guard().ok).toBe(true);
  });

  it("AC2/T2: deleting a test file is reported, renaming an unchanged one is not", () => {
    git("rm", "-q", "src/a.test.ts"); commit("delete");
    expect(rules(guard())).toEqual(["T2"]);
    git("reset", "-q", "--hard", "main");
    git("mv", "src/a.test.ts", "src/renamed.test.ts"); commit("rename");
    expect(guard().findings).toEqual([]);
  });

  it("AC3/T3: fewer assertions is reported; more, or a pure rename, is not", () => {
    write("src/a.test.ts", `import { it, expect } from "vitest";\nit("adds", () => {\n  expect(1 + 1).toBe(2);\n  expect(2 + 2).toBe(4);\n});\n`);
    commit("fewer");
    const result = guard();
    expect(rules(result)).toEqual(["T3"]);
    expect(result.findings[0].detail).toBe("断言数量 3 → 2");
    git("reset", "-q", "--hard", "main");
    write("src/a.test.ts", `${GOOD}it("more", () => { expect(1).toBe(1); });\n`); commit("more");
    expect(guard().findings).toEqual([]);
    git("reset", "-q", "--hard", "main");
    git("mv", "src/a.test.ts", "src/b.test.ts"); commit("rename");
    expect(guard().findings).toEqual([]);
  });

  it("T3 follows a rename that also removes assertions", () => {
    git("mv", "src/a.test.ts", "src/b.test.ts");
    write("src/b.test.ts", `import { it, expect } from "vitest";\nit("adds", () => {\n  expect(1 + 1).toBe(2);\n});\n`);
    commit("rename+weaken");
    expect(rules(guard())).toEqual(["T3"]);
  });

  it("AC4/T4: raising a timeout is reported, lowering it is not, config included", () => {
    write("vitest.config.ts", "export default { test: { testTimeout: 90000 } };\n"); commit("raise");
    const result = guard();
    expect(rules(result)).toEqual(["T4"]);
    expect(result.findings[0].file).toBe("vitest.config.ts");
    git("reset", "-q", "--hard", "main");
    write("vitest.config.ts", "export default { test: { testTimeout: 10000 } };\n"); commit("lower");
    expect(guard().findings).toEqual([]);
  });

  it("T4 covers per-test timeouts and retries", () => {
    write("src/a.test.ts", GOOD.replace(`it("adds", () => {`, `it("adds", { timeout: 60_000 }, () => {`));
    commit("per-test timeout");
    expect(rules(guard())).toContain("T4");
    git("reset", "-q", "--hard", "main");
    write("src/a.test.ts", `${GOOD}it("flaky", () => { expect(1).toBe(1); }, 120000);\n`); commit("trailing timeout");
    expect(rules(guard())).toContain("T4");
  });

  it("AC5/T5: modifying a snapshot or golden is reported, adding one is not", () => {
    write("src/__snapshots__/a.snap", "snap v2\n"); write("src/golden/frame.txt", "golden v2\n"); commit("edit");
    const result = guard();
    expect(result.findings.map((item: { rule: string; file: string }) => `${item.rule}:${item.file}`).sort()).toEqual(["T5:src/__snapshots__/a.snap", "T5:src/golden/frame.txt"]);
    git("reset", "-q", "--hard", "main");
    write("src/__snapshots__/new.snap", "fresh\n"); write("src/golden/new.txt", "fresh\n"); commit("add");
    expect(guard().findings).toEqual([]);
  });

  it("AC6/T6: new suppressions are reported in tests and scripts, existing ones are not", () => {
    write("scripts/tool.ts", "// @ts-ignore\nexport const value = JSON.parse('1') as any;\n");
    commit("suppress");
    const result = guard();
    expect(result.findings.map((item: { rule: string; line: number }) => `${item.rule}:${item.line}`)).toEqual(["T6:1", "T6:2"]);
    git("reset", "-q", "--hard", "main");
    write("scripts/old.ts", "export const old = {} as any;\n"); commit("pre-existing");
    git("switch", "-q", "main"); git("merge", "-q", "work"); git("switch", "-q", "work");
    write("scripts/old.ts", "export const old = {} as any;\nexport const fine = 1;\n"); commit("touch file");
    expect(guard().findings).toEqual([]);
  });

  it("T6 does not police product source outside tests and scripts", () => {
    write("tool.ts", "export const x = (1 as any);\n"); commit("source");
    expect(guard().findings).toEqual([]);
  });
});

describe("waivers", () => {
  const violate = () => {
    write("vitest.config.ts", "export default { test: { testTimeout: 90000 } };\n");
    write("src/__snapshots__/a.snap", "snap v2\n");
  };

  it("AC7: a scoped TEST-CHANGE waives only the named rule and shows the reason", () => {
    violate();
    commit("tune\n\nTEST-CHANGE: T4 慢速浏览器测试在 CI 上需要更长超时（已定位根因为 Chromium 冷启动）");
    const result = guard();
    expect(result.exitCode).toBe(1);
    expect(rules(result)).toEqual(["T5"]);
    expect(result.findings.find((item: { rule: string }) => item.rule === "T4").waived).toContain("Chromium 冷启动");
    expect(result.lines.join("\n")).toContain("已由 TEST-CHANGE 放行");
  });

  it("an unscoped TEST-CHANGE waives every rule", () => {
    violate();
    commit("tune\n\nTEST-CHANGE: 升级 vitest 后超时与快照格式整体变化，已逐项核对差异");
    expect(guard().ok).toBe(true);
  });

  it("AC8: short or filler reasons do not waive anything", () => {
    violate();
    commit("tune\n\nTEST-CHANGE: T4 太短");
    expect(guard().exitCode).toBe(1);
    git("commit", "-q", "--amend", "-m", "tune\n\nTEST-CHANGE: 同上");
    expect(guard().exitCode).toBe(1);
    expect(parseReasons("TEST-CHANGE: n/a").all).toBeNull();
  });

  it("reads the reason from TEST_CHANGE_REASON and from a PR body file", () => {
    violate(); commit("tune");
    const body = path.join(repo, "..", `pr-${path.basename(repo)}.md`);
    fs.writeFileSync(body, "## 说明\nTEST-CHANGE: T4,T5 迁移到新的渲染后端，超时与快照按新基线重新生成并人工核对\n");
    try {
      expect(guard("--pr-body-file", body).ok).toBe(true);
    } finally { fs.rmSync(body); }
    process.env.TEST_CHANGE_REASON = "TEST-CHANGE: T4,T5 通过环境变量传入的评审认可理由，用于验证优先级";
    try { expect(guard().ok).toBe(true); } finally { delete process.env.TEST_CHANGE_REASON; }
  });
});

describe("environment", () => {
  it("AC9: a missing baseline exits with 2 and a fix-it hint", () => {
    expect(() => run(["--base", "nope"], repo)).toThrow(/git fetch origin main|--base/);
    expect(() => resolveBase(repo, "nope")).toThrow(/找不到基线分支/);
  });

  it("AC10: paths with spaces and Chinese characters are checked", () => {
    write("src/带 空格的 测试.test.ts", GOOD); commit("base2");
    git("switch", "-q", "main"); git("merge", "-q", "work"); git("switch", "-q", "work");
    write("src/带 空格的 测试.test.ts", `import { it } from "vitest";\nit.skip("x", () => {});\n`); commit("weaken");
    const result = guard();
    expect(rules(result)).toEqual(["T1", "T3"]);
    expect(result.findings.every((item: { file: string }) => item.file === "src/带 空格的 测试.test.ts")).toBe(true);
  });

  it("AC-ERR1: an empty diff passes", () => {
    const result = guard();
    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("没有测试文件变化或削弱。");
  });

  it("handles CRLF files without counting line-ending noise as changes", () => {
    write("src/crlf.test.ts", GOOD.replace(/\n/g, "\r\n")); commit("crlf base");
    git("switch", "-q", "main"); git("merge", "-q", "work"); git("switch", "-q", "work");
    write("src/crlf.test.ts", GOOD.replace(/\n/g, "\r\n") + "\r\n"); commit("trailing newline");
    expect(guard().findings).toEqual([]);
  });

  it("rejects unknown arguments", () => {
    expect(() => run(["--bogus"], repo)).toThrow(/未知参数/);
  });

  it("CLI exit codes: 0 clean, 1 violation, 2 cannot run; --json is machine readable", () => {
    const script = path.resolve(__dirname, "check-tests.mjs");
    const cli = (...args: string[]) => spawnSync("node", [script, ...args], { cwd: repo, encoding: "utf8" });
    expect(cli("--base", "main").status).toBe(0);
    const missing = cli("--base", "nope");
    expect(missing.status).toBe(2);
    expect(missing.stderr).toMatch(/git fetch origin main|--base/);
    write("src/a.test.ts", `${GOOD}it.only("x", () => {});\n`); commit("only");
    const failing = cli("--base", "main", "--json");
    expect(failing.status).toBe(1);
    expect(JSON.parse(failing.stdout).findings[0]).toMatchObject({ rule: "T1", line: 7 });
  });

  it("works from a detached merge-base when the branch is behind main", () => {
    git("switch", "-q", "main"); write("tool.ts", "export const x = 3;\n"); commit("main moves on"); git("switch", "-q", "work");
    write("src/a.test.ts", `${GOOD}it.skip("x", () => {});\n`); commit("skip");
    expect(rules(guard())).toEqual(["T1"]);
  });
});
