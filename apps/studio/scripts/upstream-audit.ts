import fs from "node:fs";
import path from "node:path";

/**
 * SKILL-11 升级回归夹具：对九项上游（BASE-06 审计的固定 commit/许可证）做漂移核查。
 * 输出每项的 head commit 是否前进、许可证是否变化；任何漂移都要求重跑该上游的
 * smoke fixture 并更新审计记录后，才允许跟随升级。只读 API，不改任何本地文件。
 * last_commit 若不是 commit sha（如 BASE-06 记的是审计日期），归入 unpinned 显式
 * 上报——不能假装修比过，也不许冒充「漂移」。
 */

export interface UpstreamRecord { id: string; candidate: string; resolved_url: string; license: string; last_commit: string }
export interface UpstreamDrift { id: string; url: string; commitDrifted: boolean; headCommit?: string; licenseChanged?: boolean; headLicense?: string; note: string }
export interface UnpinnedRecord { id: string; url: string; last_commit: string; headCommit: string; headLicense: string; note: string }

const SHA_LIKE = /^[0-9a-f]{7,40}$/i;
const JSON_FETCH_INIT = { headers: { "user-agent": "glint-upstream-audit", accept: "application/vnd.github+json" } } as const;

export async function auditUpstreams(options: { auditFile: string; signal?: AbortSignal; fetchImpl?: typeof fetch }): Promise<{ records: number; drifts: UpstreamDrift[]; unpinned: UnpinnedRecord[] }> {
  const lines = fs.readFileSync(options.auditFile, "utf8").split("\n").filter(line => line.trim());
  if (!lines.length) throw new Error("审计记录为空；先运行 BASE-06 的九项身份审计。");
  const records = lines.map(line => JSON.parse(line) as UpstreamRecord);
  const doFetch = options.fetchImpl ?? fetch;
  const drifts: UpstreamDrift[] = [];
  const unpinned: UnpinnedRecord[] = [];
  // 非 2xx 显式抛错（带限流标记）：403 响应体不是异常，会静默解析成空数据——不许。
  const getJson = async (url: string): Promise<Record<string, unknown>> => {
    const response = await doFetch(url, { ...JSON_FETCH_INIT, signal: options.signal });
    if (!response.ok) throw new Error(`GitHub API ${response.status}${response.headers.get("x-ratelimit-remaining") === "0" ? "（限流：60/小时配额用尽）" : ""}`);
    return response.json() as Promise<Record<string, unknown>>;
  };
  for (const record of records) {
    const match = record.resolved_url.match(/github\.com\/([^/]+)\/([^/]+)/i);
    if (!match) { drifts.push({ id: record.id, url: record.resolved_url, commitDrifted: true, note: "URL 不是 GitHub 仓库，无法自动核查" }); continue; }
    const repo = `${match[1]}/${match[2]!.replace(/\.git$/, "")}`;
    const pinnedSha = record.last_commit.replace(/^"|"$/g, "");
    try {
      const repoInfo = await getJson(`https://api.github.com/repos/${repo}`);
      const head = String(repoInfo?.default_branch ?? "main");
      const commitInfo = await getJson(`https://api.github.com/repos/${repo}/commits/${head}`);
      const headCommit = String(commitInfo?.sha ?? "").slice(0, 8);
      // 403/限流的响应体不是异常，会被解析成空 sha——必须显式失败，不许静默放行。
      if (!headCommit) {
        drifts.push({ id: record.id, url: record.resolved_url, commitDrifted: true, note: "核查失败（GitHub API 无有效返回，可能限流）：head sha 缺失；升级前须重跑至真实返回" });
        continue;
      }
      // repo API 自带 license 字段（省一次请求）；缺失才回退 /license 端点。
      const licenseFallback = repoInfo?.license ? Promise.resolve(repoInfo) : getJson(`https://api.github.com/repos/${repo}/license`);
      const licenseInfo = await licenseFallback;
      const headLicense = String((licenseInfo?.license as { spdx_id?: string } | undefined)?.spdx_id ?? "unknown");
      // NOASSERTION=仓库带自定义许可文本（GitHub 无法归类），不是变化证据；
      // BASE-06 已知 S03/S04/S09 属此类，只有拿到具体 SPDX 且与记录不符才算漂移。
      const licenseChanged = headLicense !== "unknown" && headLicense !== "NOASSERTION" && !record.license.includes(headLicense);
      if (!SHA_LIKE.test(pinnedSha)) {
        unpinned.push({
          id: record.id, url: record.resolved_url, last_commit: record.last_commit, headCommit, headLicense,
          note: `记录 last_commit="${record.last_commit}" 不是 commit sha（未固定版本）；当前 head=${headCommit}、license=${headLicense}${licenseChanged ? `；许可证变化（记录 ${record.license} → head ${headLicense}）` : ""}。升级回归前须先把 sha 固定进审计记录。`,
        });
        if (licenseChanged) drifts.push({ id: record.id, url: record.resolved_url, commitDrifted: false, headCommit, licenseChanged: true, headLicense, note: `许可证变化（记录 ${record.license} → head ${headLicense}）；last_commit 未固定 sha，commit 漂移无法判定` });
        continue;
      }
      const commitDrifted = Boolean(headCommit) && headCommit !== pinnedSha;
      if (commitDrifted || licenseChanged) {
        drifts.push({
          id: record.id, url: record.resolved_url, commitDrifted, headCommit, licenseChanged, headLicense,
          note: [commitDrifted ? `commit 已前进（记录 ${pinnedSha} → head ${headCommit}）` : "", licenseChanged ? `许可证变化（记录 ${record.license} → head ${headLicense}）` : ""].filter(Boolean).join("；"),
        });
      }
    } catch (error) {
      drifts.push({ id: record.id, url: record.resolved_url, commitDrifted: true, note: `核查失败（网络或限流）：${error instanceof Error ? error.message.slice(0, 120) : "unknown"}` });
    }
  }
  return { records: records.length, drifts, unpinned };
}

/** CLI entry: `tsx upstream-audit.ts --audit=<jsonl> [--out=<json>]`（真实 GitHub API，免费）。 */
if (process.argv[1] && /upstream-audit\.(?:ts|mjs|js)$/.test(process.argv[1])) {
  const arg = (name: string) => process.argv.slice(2).find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
  const auditFile = arg("audit");
  if (!auditFile) { console.error("[glint] upstream-audit requires --audit=<audit.jsonl> [--out=<archive.json>]"); process.exit(1); }
  auditUpstreams({ auditFile })
    .then(result => {
      const archive = { ranAt: new Date().toISOString(), auditFile, ...result };
      if (arg("out")) { fs.mkdirSync(path.dirname(path.resolve(arg("out")!)), { recursive: true }); fs.writeFileSync(arg("out")!, JSON.stringify(archive, null, 2)); }
      console.log(JSON.stringify(archive, null, 2));
    })
    .catch(error => { console.error(`[glint] failed: ${error instanceof Error ? error.message : String(error)}`); process.exit(1); });
}
