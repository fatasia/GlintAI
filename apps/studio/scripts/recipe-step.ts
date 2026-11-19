import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import type { TaskStep } from "./agent-tasks";
/** Shared subprocess implementation; plans remain validated by their caller. */
export function executeAgentStep(
  baseDir: string,
  step: TaskStep,
  event: (message: string) => void,
): Promise<void> {
  const require = createRequire(import.meta.url);
  const script = fileURLToPath(new URL("./glint.ts", import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", pathToFileURL(require.resolve("tsx")).href, script, step.tool, ...step.args],
      {
        cwd: baseDir,
        env: { ...process.env, INIT_CWD: path.resolve(baseDir) },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      process.stdout.write(text);
      event(text);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      process.stderr.write(text);
      event(text);
    });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error("Step " + step.id + " exited with code " + code)),
    );
  });
}
