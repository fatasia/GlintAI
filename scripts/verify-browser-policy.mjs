import fs from "node:fs";
import path from "node:path";

const historical = new Set(["style-entry.browser.test.ts", "style-trial.browser.test.ts", "style-contrast.browser.test.ts", "style-sample-playback.browser.test.ts"]);

export function browserSelection(repo, args) {
  const selected = args.filter(arg => arg !== "--");
  const root = fs.realpathSync(repo);
  for (const file of selected) {
    const resolved = path.resolve(root, file);
    if (!file.endsWith(".browser.test.ts") || !resolved.startsWith(root + path.sep) || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error("Browser selections must be existing repository .browser.test.ts files.");
    if (!fs.realpathSync(resolved).startsWith(root + path.sep)) throw new Error("Browser selection must not escape through a symlink.");
  }
  const requiresStyles = selected.length === 0 || selected.some(file => historical.has(path.basename(file)));
  if (requiresStyles && !fs.existsSync(path.join(root, "outputs/style-samples"))) throw new Error("Historical style samples are required; generate them before this suite.");
  return { selected, requiresStyles };
}

/** A real launch/close is supplied by the runner; failure must happen before tests can skip. */
export async function requireBrowser(check) {
  const executable = await check();
  if (typeof executable !== "string" || !executable.trim()) throw new Error("Browser preflight returned no executable; install Chrome/Edge or set GLINT_CHROME_PATH.");
  return executable;
}

export function assertBrowserResults(report, selected) {
  if (!report || report.success !== true || !(report.numPassedTests > 0) || report.numFailedTests !== 0) throw new Error("Browser verification requires a successful report with executed tests.");
  if (!selected.length) return; // Preserve unrelated full-suite explicit opt-ins.
  if (report.numPendingTests !== 0 || (report.numTodoTests ?? 0) !== 0) throw new Error("Selected browser tests must not skip or remain todo.");
  for (const file of selected) {
    const suffix = file.replaceAll("\\", "/").replace(/^\.\//, "");
    const result = report.testResults?.find(item => item.name.replaceAll("\\", "/").endsWith(suffix));
    if (!result?.assertionResults?.some(item => item.status === "passed") || result.assertionResults.some(item => item.status !== "passed")) throw new Error(`Selected browser file did not fully execute: ${file}`);
  }
}
