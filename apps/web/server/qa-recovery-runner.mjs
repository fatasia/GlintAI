// QA-05 child process: real web server whose media gateway client is a
// counting stub (the drill must not spend gateway credit). Prints READY <port>.
import fs from "node:fs";
import path from "node:path";
import { createWebServer } from "./index.mjs";
import { createMediaJobs } from "./media-jobs.mjs";

const work = process.env.GLINT_QA05_WORK;
const mediaRoot = process.env.GLINT_QA05_MEDIA_ROOT ?? path.join(work, "media");
const countersFile = path.join(work, "counters.json");
const readCounters = () => { try { return JSON.parse(fs.readFileSync(countersFile, "utf8")); } catch { return {}; } };
const counters = readCounters();
counters.submits ??= 0; counters.polls ??= {};
const submitDelayMs = Number(process.env.GLINT_QA05_SUBMIT_DELAY ?? 0);
const pollsToFinal = Number(process.env.GLINT_QA05_POLLS_TO_FINAL ?? 2);
const pngBytes = fs.readFileSync(process.env.GLINT_QA05_PNG);
const persist = () => fs.writeFileSync(countersFile, JSON.stringify(counters));
const stubClient = {
  async models() { return []; },
  async pricing() { throw new Error("stub gateway has no pricing"); },
  async submit(model, prompt, params, signal) {
    counters.submits += 1; persist();
    if (submitDelayMs > 0) await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, submitDelayMs);
      signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason ?? new Error("aborted")); }, { once: true });
    });
    const taskId = `stub-${counters.submits}`;
    counters.polls[taskId] = 0; persist();
    return taskId;
  },
  async status(taskId) {
    const seen = (counters.polls[taskId] ?? 0) + 1;
    counters.polls[taskId] = seen; persist();
    const final = seen >= pollsToFinal;
    return { task_id: taskId, state: final ? "success" : "running", is_final: final, ...(final ? { cost: 0.5, result_url: "https://cdn.stub.invalid/result.png" } : {}) };
  },
};
const mediaJobs = createMediaJobs(mediaRoot, process.env, {
  client: stubClient,
  // The CDN is stubbed as well: a recovery drill must not need the public internet.
  download: async () => ({ contentType: "image/png", bytes: pngBytes }),
});
const server = createWebServer({ mediaJobs });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
console.log(`READY ${server.address().port}`);
