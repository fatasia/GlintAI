import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { browserSelection, requireBrowser, assertBrowserResults } from "./verify-browser-policy.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));
const dist = process.env.GLINT_TEST_WEB_DIST ?? path.join(repo, "apps/web/dist");
if (!path.isAbsolute(dist)) throw new Error("GLINT_TEST_WEB_DIST must be absolute.");
if (!fs.existsSync(path.join(dist, "index.html"))) throw new Error("Build the Web app before browser verification.");
const { selected, requiresStyles } = browserSelection(repo, process.argv.slice(2));
const studioRequire = createRequire(new URL("../apps/studio/package.json", import.meta.url));
const browser = await requireBrowser(async () => {
  const host = new URL("../apps/studio/scripts/direct-browser/host.ts", import.meta.url).href;
  const code = `import { findSystemBrowser, openCaptureBrowser } from ${JSON.stringify(host)}; const executable = findSystemBrowser(); const opened = await openCaptureBrowser(320,240); await opened.browser.close(); console.log(JSON.stringify(executable));`;
  return JSON.parse(execFileSync(process.execPath, ["--import", pathToFileURL(studioRequire.resolve("tsx")).href, "--input-type=module", "-e", code], { cwd: repo, env: process.env, encoding: "utf8", windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024 }).trim());
});
const output = fs.mkdtempSync(path.join(os.tmpdir(),"glint-browser-check-"));
fs.cpSync(dist,path.join(output,"dist"),{recursive:true});
const evidence = path.join(output,"style-evidence");
fs.mkdirSync(evidence);
const env = {...process.env,GLINT_CHROME_PATH:browser,GLINT_BROWSER_UI_TEST:"1",GLINT_TEST_REAL_STUDIO:"1",GLINT_TEST_STYLE_FIXTURES:requiresStyles ? "1" : "0",GLINT_TEST_WEB_DIST:path.join(output,"dist"),GLINT_STYLE_HISTORY_EVIDENCE:evidence};
const log = fs.createWriteStream(path.join(output,"verify.log"));
const vitest = path.join(repo,"node_modules/vitest/vitest.mjs");
const results = path.join(output, "vitest.json");
const startedAt = new Date().toISOString();
console.log(`[browser] frozen Web build and isolated services: ${output}`);
const child = spawn(process.execPath,[vitest,"run",...(selected.length ? selected : ["browser.test.ts"]),"--maxWorkers=1","--minWorkers=1","--reporter=default","--reporter=json",`--outputFile.json=${results}`],{cwd:repo,env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
child.stdout.on("data",chunk=>{log.write(chunk);process.stdout.write(chunk);});
child.stderr.on("data",chunk=>{log.write(chunk);process.stderr.write(chunk);});
child.on("error",error=>{log.end(String(error));process.exitCode=1;});
child.on("close",code=>{
  let failure;
  try { assertBrowserResults(JSON.parse(fs.readFileSync(results,"utf8")), selected); }
  catch (error) { failure = error.message; console.error(`[browser] ${failure}`); }
  log.end();process.exitCode=code === 0 && !failure ? 0 : (code || 1);
  fs.writeFileSync(path.join(output,"report.json"),JSON.stringify({startedAt,finishedAt:new Date().toISOString(),exitCode:process.exitCode,output,selected,requiresStyles,failure,scope:"Opt-in Chromium UI/render tests with local fixtures; no paid provider quality claim"},null,2));
});
