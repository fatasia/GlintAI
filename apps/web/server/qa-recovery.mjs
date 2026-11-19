// QA-05 recovery drill: kill / restart / storage-failure across the real
// server process. Proves, without spending gateway credit:
//   A. an in-flight submit that lost its receipt is refused on retry — the
//      gateway is never asked twice for the same money (no double billing);
//   B. a killed server resumes a job whose receipt survived: same task id,
//      asset served, cost recorded exactly once, no second submission;
//   C. an unusable media root fails loudly at startup instead of running
//      half-configured.
//   node qa-recovery.mjs --out=evidence/QA-05/run-<date>
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (name) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const outDir = arg("out") ?? path.join("evidence", "QA-05", `run-${new Date().toISOString().slice(0, 10)}`);
fs.mkdirSync(outDir, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), "glint-qa05-"));
const fixturePng = path.join(work, "fixture.png");
const probe = spawnSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=red:s=64x64", "-frames:v", "1", fixturePng], { stdio: "ignore" });
assert.equal(probe.status, 0, "ffmpeg must produce the fixture png");

let scenario = "";
const log = line => { console.log(line); fs.appendFileSync(path.join(outDir, "drill.log"), `${line}\n`); };
const counters = () => JSON.parse(fs.readFileSync(path.join(work, "counters.json"), "utf8"));
const api = async (port, route, init) => {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, init);
  return { status: response.status, body: await response.json().catch(() => null) };
};
const spawnRunner = extra => {
  // `node --import tsx` registers the loader in-process. Spawning the tsx CLI
  // instead would put the server in a grandchild that survives our SIGKILL.
  const child = spawn(process.execPath, ["--import", "tsx", path.join(here, "qa-recovery-runner.mjs")], {
    cwd: path.join(here, ".."),
    // The env gate in media-jobs client() runs before dependency injection, so
    // the drill carries dummy credentials that never reach the network.
    env: { ...process.env, GLINT_MEDIA_BASE_URL: "https://qa05.stub.invalid", GLINT_MEDIA_API_KEY: "qa05-stub", GLINT_QA05_WORK: work, GLINT_QA05_PNG: fixturePng, ...extra },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const port = new Promise((resolve, reject) => {
    child.once("exit", code => reject(new Error(`runner exited early (${code}): ${stderr.slice(0, 400)}`)));
    child.stdout.on("data", () => {
      const ready = /READY (\d+)/.exec(stdout);
      if (ready) resolve(Number(ready[1]));
    });
  });
  return { child, port, stdout: () => stdout, stderr: () => stderr };
};
const kill = child => new Promise(resolve => {
  child.once("exit", resolve);
  child.kill("SIGKILL");
});
const submit = (port, requestId) => api(port, "/api/media/submit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "image", model: "stub-image", requestId, prompt: `QA-05 恢复演练 ${requestId}`, params: {} }) });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// A. Receipt lost mid-submit: retry must be refused, gateway asked once.
scenario = "A-uncertain-submit-no-double-billing";
{
  const first = spawnRunner({ GLINT_QA05_SUBMIT_DELAY: "6000" });
  const port = await first.port;
  const inflight = submit(port, "qa05a").catch(error => String(error.cause?.code ?? error.message));
  await sleep(2000);
  await kill(first.child);
  const firstOutcome = await inflight;
  const retryRunner = spawnRunner({});
  const retryPort = await retryRunner.port;
  const retry = await submit(retryPort, "qa05a");
  const receipt = await api(retryPort, "/api/media/request/qa05a");
  log(`[${scenario}] first submit outcome after kill: ${typeof firstOutcome === "string" ? firstOutcome : JSON.stringify(firstOutcome)}`);
  log(`[${scenario}] retry status=${retry.status} error=${retry.body?.error}`);
  log(`[${scenario}] receipt lookup status=${receipt.status}`);
  log(`[${scenario}] gateway submits=${counters().submits}`);
  assert.match(typeof firstOutcome === "string" ? firstOutcome : JSON.stringify(firstOutcome), /ECONNRESET|terminated|fetch failed/i);
  assert.notEqual(retry.status, 202);
  assert.match(retry.body?.error ?? "", /uncertain|resubmit/i);
  assert.equal(receipt.status, 404);
  assert.equal(counters().submits, 1);
  log(`[${scenario}] PASS`);
}

// B. Receipt survived: kill after submit, restart, resume to served asset.
scenario = "B-kill-restart-resume-cost-once";
{
  const runner = spawnRunner({});
  const port = await runner.port;
  const created = await submit(port, "qa05b");
  assert.equal(created.status, 202);
  const taskId = created.body.taskId;
  const before = await api(port, `/api/media/status/${taskId}`);
  assert.equal(before.body.isFinal, false);
  await kill(runner.child);
  const resumed = spawnRunner({});
  const resumePort = await resumed.port;
  let final;
  for (let attempt = 0; attempt < 10; attempt++) {
    final = await api(resumePort, `/api/media/status/${taskId}`);
    if (final.body.isFinal) break;
    await sleep(300);
  }
  assert.equal(final.body.state, "success");
  const asset = await fetch(`http://127.0.0.1:${resumePort}${final.body.assetUrl}`);
  const bytes = Buffer.from(await asset.arrayBuffer());
  const spend = JSON.parse(fs.readFileSync(path.join(work, "media", "spend.json"), "utf8"));
  const record = JSON.parse(fs.readFileSync(path.join(work, "media", `${taskId}.json`), "utf8"));
  const again = await api(resumePort, `/api/media/status/${taskId}`);
  log(`[${scenario}] taskId=${taskId} assetBytes=${bytes.length} spend=${JSON.stringify(spend)} costRecorded=${record.costRecorded}`);
  assert.equal(asset.status, 200);
  assert.ok(bytes.equals(fs.readFileSync(fixturePng)), "served asset must be the generated png");
  assert.equal(spend.total, 0.5);
  assert.equal(spend.count, 1);
  assert.equal(record.costRecorded, true);
  assert.equal(again.body.assetUrl, final.body.assetUrl, "a settled task must serve the same asset without re-downloading");
  assert.equal(counters().submits, 2, "scenario B must not resubmit the job");
  log(`[${scenario}] PASS`);
}

// C. Media root unusable: construction fails loudly, no half-configured server.
scenario = "C-storage-root-unusable-fails-loudly";
{
  const blocked = path.join(work, "media-blocked");
  fs.writeFileSync(blocked, "not a directory");
  const runner = spawnRunner({ GLINT_QA05_MEDIA_ROOT: blocked });
  const outcome = await new Promise(resolve => {
    runner.child.once("exit", (code, signal) => resolve({ code, signal, stderr: runner.stderr() }));
  });
  log(`[${scenario}] runner exit=${outcome.code} stderr=${outcome.stderr.slice(0, 200).replace(/\n/g, " ")}`);
  assert.notEqual(outcome.code, 0);
  assert.match(outcome.stderr, /EEXIST|ENOTDIR|not a directory|directory/i);
  log(`[${scenario}] PASS`);
}

const summary = {
  ranAt: new Date().toISOString(),
  scenarios: [
    { id: "A", name: "receipt lost mid-submit: retry refused, gateway asked once" },
    { id: "B", name: "kill after receipt: restart resumes to asset, cost recorded once" },
    { id: "C", name: "unusable media root: startup fails loudly" },
  ],
  workDir: work,
};
fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
log(`SUMMARY ${JSON.stringify(summary)}`);
process.exit(0);
