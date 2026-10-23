import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const PATH_ARGS = new Set(["source", "code", "project", "export-project", "analysis", "out", "video", "audio", "plan", "src", "mask", "dir", "task-dir", "feedback", "beats-grid", "batch", "adapters", "persona-pack", "tts-model", "transcription-model", "reference-audio", "params", "store", "operations", "tests", "receipt", "before", "after", "against"]);
const SCRIPT_NAMES = new Set(["render", "render-worker", "native-worker", "preview-code", "ask", "rehearse", "reexplain", "media", "nle-render"]);

export function resolvePaths(args: string[], callerDir: string): string[] {
  return args.map((arg) => {
    const match = /^--([^=]+)=(.*)$/s.exec(arg);
    if (!match) return arg;
    const [, name, value] = match;
    if (["tts-python","media-python"].includes(name!) && /[\\/]/.test(value ?? "")) return `--${name}=${path.resolve(callerDir, value!)}`;
    if (["source","catalog"].includes(name!) && /^[a-z][a-z\d+.-]*:\/\//i.test(value!)) {
      const url = new URL(value!);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("Source URL must use HTTP(S)");
      return arg;
    }
    if(name === "catalog")return `--catalog=${path.resolve(callerDir,value!)}`;
    if(name === "preview-config")return `--preview-config=${path.resolve(callerDir,value!)}`;
    if (PATH_ARGS.has(name!) || (name === "music" && !["auto", "off", "synth", "existing", "minimax", "gateway"].includes(value!))) {
      if (!value?.trim()) throw new Error(`--${name} requires a path`);
      return `--${name}=${path.resolve(callerDir, value)}`;
    }
    return arg;
  });
}

export function sourceInput(args: string[]): { path?: string; url?: string; idea?: string; code?: string } {
  const source = readArg(args, "source");
  const sourceIsUrl = source !== undefined && /^https?:\/\//i.test(source);
  const url = readArg(args, "url");
  if (sourceIsUrl && url !== undefined) throw new Error("Provide exactly one source or url");
  return { path: sourceIsUrl ? undefined : source, url: sourceIsUrl ? source : url, idea: readArg(args, "idea"), code: readArg(args, "code") };
}

export function readArg(args: string[], name: string): string | undefined {
  return args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

export function renderArgs(projectPath: string, args: string[]): string[] {
  return [
    `--project=${projectPath}`,
    `--music=${readArg(args, "music") ?? "auto"}`,
    ...["tts", "tts-concurrency", "tts-python", "tts-model", "reference-audio", "reference-text", "voice", "format", "frame", "encoding", "aspect", "out", "concurrency"].flatMap((name) => {
      const value = readArg(args, name);
      return value !== undefined ? [`--${name}=${value}`] : [];
    }),
    ...(args.includes("--fast") ? ["--fast"] : []),
    ...(args.includes("--no-cache") ? ["--no-cache"] : []),
  ];
}

export function createCliRuntime(entryUrl: string, callerDir = process.env.INIT_CWD || process.cwd()) {
  const entryPath = fileURLToPath(entryUrl);
  const entryDir = path.dirname(entryPath);
  // Packaged builds place the bundle outside the studio tree; the launcher pins the
  // writable studio directory instead of deriving it from the bundle location. When
  // the CLI is a built .mjs (app/cli/glint.mjs), the studio tree is its sibling.
  const packaged = path.basename(entryPath) === "glint.mjs" || fs.existsSync(path.join(entryDir, "render.mjs"));
  const studioDir = process.env.GLINT_STUDIO_DIR
    ? path.resolve(process.env.GLINT_STUDIO_DIR)
    : packaged
      ? path.resolve(entryDir, "..", "studio")
      : path.resolve(entryDir, "..");
  const require = createRequire(entryUrl);
  const run = (args: string[]): Promise<void> => new Promise((resolve, reject) => {
    // Never pass user-controlled arguments through a shell, including on Windows.
    const child = spawn(process.execPath, args, { shell: false, stdio: "inherit", cwd: studioDir });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`command exited: ${code ?? signal}`));
    });
  });
  const scriptArgs = (name: string, args: string[]) => {
    if (!SCRIPT_NAMES.has(name)) throw new Error(`Unknown CLI script: ${name}`);
    // Packaged builds ship each worker as a sibling .mjs entry (no tsx, no
    // TypeScript sources). Spawn it directly; re-entering the CLI would recurse.
    const sibling = path.join(entryDir, `${name}.mjs`);
    if (fs.existsSync(sibling)) return [sibling, ...args];
    const bundled = process.env.GLINT_CLI_ENTRY;
    if (bundled) return [bundled, name, ...args];
    return ["--import", pathToFileURL(require.resolve("tsx")).href, path.join(studioDir, "scripts", `${name}.ts`), ...args];
  };
  return {
    studioDir,
    resolvePaths: (args: string[]) => resolvePaths(args, callerDir),
    scriptArgs,
    runScript: (name: string, args: string[]) => run(scriptArgs(name, args)),
    runStudio: () => run([path.join(path.dirname(require.resolve("@remotion/cli/package.json")), "remotion-cli.js"), "studio", "src/index.ts"]),
  };
}
