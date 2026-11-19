// @vitest-environment node
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { auditUpstreams } from "./upstream-audit";

const RECORD = { id: "S01", candidate: "alchaincyf/huashu-art-motion", resolved_url: "https://github.com/alchaincyf/huashu-art-motion", license: "MIT", last_commit: "aaaaaaa" };
const jsonResponse = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

function githubFetch(sha: string, license: string) {
  return (async (url: string | URL | Request) => {
    const target = String(url);
    if (target.endsWith("/license")) return jsonResponse({ license: { spdx_id: license } });
    if (/\/commits\//.test(target)) return jsonResponse({ sha });
    return jsonResponse({ default_branch: "main", license: { spdx_id: license } });
  }) as unknown as typeof fetch;
}

describe("SKILL-11 upstream audit", () => {
  it("reports no drift when the pinned commit and license still match", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glint-upstream-"));
    const file = path.join(dir, "audit.jsonl");
    fs.writeFileSync(file, JSON.stringify(RECORD) + "\n");
    const result = await auditUpstreams({ auditFile: file, fetchImpl: githubFetch("aaaaaaa", "MIT") });
    expect(result.records).toBe(1);
    expect(result.drifts).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it("flags commit drift and license changes separately", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glint-upstream-"));
    const file = path.join(dir, "audit.jsonl");
    fs.writeFileSync(file, JSON.stringify(RECORD) + "\n");
    const result = await auditUpstreams({ auditFile: file, fetchImpl: githubFetch("bbbbbbb", "AGPL-3.0") });
    expect(result.drifts).toHaveLength(1);
    expect(result.drifts[0]).toMatchObject({ id: "S01", commitDrifted: true, headCommit: "bbbbbbb", licenseChanged: true, headLicense: "AGPL-3.0" });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it("fails closed on a fetch failure so upgrades are not silently waved through", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glint-upstream-"));
    const file = path.join(dir, "audit.jsonl");
    fs.writeFileSync(file, JSON.stringify(RECORD) + "\n");
    const result = await auditUpstreams({ auditFile: file, fetchImpl: (async () => { throw new Error("rate limited"); }) as unknown as typeof fetch });
    expect(result.drifts[0]!.note).toContain("rate limited");
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it("fails closed when the API answers but carries no sha (e.g. a 403 body)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glint-upstream-"));
    const file = path.join(dir, "audit.jsonl");
    fs.writeFileSync(file, JSON.stringify(RECORD) + "\n");
    const result = await auditUpstreams({ auditFile: file, fetchImpl: githubFetch("", "MIT") });
    expect(result.drifts).toHaveLength(1);
    expect(result.drifts[0]!.note).toContain("head sha 缺失");
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it("reports a date-shaped last_commit as unpinned instead of a false commit drift", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glint-upstream-"));
    const file = path.join(dir, "audit.jsonl");
    // BASE-06 记录的 last_commit 是审计日期（2026-10-16），不是 sha。
    fs.writeFileSync(file, JSON.stringify({ ...RECORD, last_commit: "2026-10-16" }) + "\n");
    const result = await auditUpstreams({ auditFile: file, fetchImpl: githubFetch("bbbbbbb", "MIT") });
    expect(result.drifts).toEqual([]); // 日期 vs sha 不可比，不得假报「commit 已前进」
    expect(result.unpinned).toHaveLength(1);
    expect(result.unpinned[0]).toMatchObject({ id: "S01", last_commit: "2026-10-16", headCommit: "bbbbbbb", headLicense: "MIT" });
    expect(result.unpinned[0]!.note).toContain("未固定版本");
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it("unpinned 记录仍查许可证漂移；NOASSERTION（自定义许可文本）不算变化", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glint-upstream-"));
    const file = path.join(dir, "audit.jsonl");
    fs.writeFileSync(file, [
      JSON.stringify({ ...RECORD, id: "SA", last_commit: "2026-10-16", license: "MIT" }),
      JSON.stringify({ ...RECORD, id: "SB", last_commit: "2026-10-16", license: "MIT(代码;示例音频除外)" }),
      JSON.stringify({ ...RECORD, id: "SC", last_commit: "2026-10-16", license: "MIT" }),
    ].join("\n") + "\n");
    let call = 0;
    const licenses = ["Apache-2.0", "NOASSERTION", "MIT"]; // SA 变许可、SB 自定义文本、SC 不变
    const fetchImpl = (async (url: string | URL | Request) => {
      const target = String(url);
      if (/\/commits\//.test(target)) return jsonResponse({ sha: "ccccccc" });
      return jsonResponse({ default_branch: "main", license: { spdx_id: licenses[call++] } });
    }) as unknown as typeof fetch;
    const result = await auditUpstreams({ auditFile: file, fetchImpl });
    expect(result.drifts.map(drift => drift.id)).toEqual(["SA"]); // 只有具体 SPDX 变化才报漂移
    expect(result.drifts[0]).toMatchObject({ commitDrifted: false, licenseChanged: true, headLicense: "Apache-2.0" });
    expect(result.unpinned).toHaveLength(3);
    expect(result.unpinned[1]!.headLicense).toBe("NOASSERTION");
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it("403（限流）响应显式失败并带配额标记，不许静默放行", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glint-upstream-"));
    const file = path.join(dir, "audit.jsonl");
    fs.writeFileSync(file, JSON.stringify(RECORD) + "\n");
    const fetchImpl = (async () => new Response(JSON.stringify({ message: "API rate limit exceeded" }), { status: 403, headers: { "content-type": "application/json", "x-ratelimit-remaining": "0" } })) as unknown as typeof fetch;
    const result = await auditUpstreams({ auditFile: file, fetchImpl });
    expect(result.drifts).toHaveLength(1);
    expect(result.drifts[0]!.note).toContain("限流");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
