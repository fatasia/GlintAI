import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, prepare, safePath } from "./prepare-test-fixtures.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIMIT = 1024 * 1024;

export function sourceConfig(env, cases) {
  const directory = env.GLINT_CI_GOLDENS_DIR;
  const remote = env.GLINT_CI_GOLDENS_URLS;
  if (Boolean(directory) === Boolean(remote)) {
    throw new Error("Configure exactly one owner-approved golden directory or URL map");
  }
  if (directory) return { directory: path.resolve(directory) };
  let urls;
  try {
    urls = JSON.parse(remote);
  } catch {
    throw new Error("Invalid golden URL map");
  }
  if (
    !urls ||
    Array.isArray(urls) ||
    typeof urls !== "object" ||
    Object.keys(urls).length !== 4 ||
    cases.some((item) => !Object.hasOwn(urls, item.id))
  ) {
    throw new Error("Golden URL map must contain exactly the four locked fixture IDs");
  }
  for (const value of Object.values(urls)) {
    try {
      if (typeof value !== "string" || value.length > 2048) throw new Error();
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
        throw new Error();
    } catch {
      throw new Error("Golden URLs require HTTPS without credentials, query or fragment");
    }
  }
  return { urls };
}

function lockedCases(root) {
  const config = JSON.parse(
    fs.readFileSync(safePath(root, "apps/studio/scripts/reference-eval-fixtures.json"), "utf8"),
  );
  const cases = config.cases;
  if (
    !Array.isArray(cases) ||
    cases.length !== 4 ||
    new Set(cases.map((item) => item.id)).size !== 4 ||
    cases.some(
      (item) =>
        typeof item.id !== "string" ||
        !/^[a-f0-9]{64}$/.test(item.sha256) ||
        !/^evidence\/(SKILL-01|MOTION-05)\//.test(item.path),
    )
  ) {
    throw new Error("Invalid locked fixture manifest");
  }
  return cases;
}

export async function fetchCiGolden(url, signal) {
  const require = createRequire(path.join(ROOT, "apps/studio/package.json"));
  const { tsImport } = await import(pathToFileURL(require.resolve("tsx/esm/api")).href);
  const { fetchPublicAsset } = await tsImport(
    pathToFileURL(path.join(ROOT, "packages/knowledge/src/index.ts")).href,
    import.meta.url,
  );
  return fetchPublicAsset(url, signal, 0, true);
}

export async function prepareCiGoldens(
  root,
  env,
  fetchAsset = fetchCiGolden,
  runPrepare = prepare,
) {
  const cases = lockedCases(root),
    config = sourceConfig(env, cases);
  if (config.directory) {
    try {
      return runPrepare(root, { stages: ["goldens"], goldens: config.directory });
    } catch {
      throw new Error("Local golden preparation failed; verify the four locked files");
    }
  }
  const parent = fs.realpathSync(os.tmpdir());
  const temporary = fs.mkdtempSync(path.join(parent, "glint-ci-goldens-"));
  try {
    for (const item of cases) {
      let bytes;
      try {
        ({ bytes } = await fetchAsset(config.urls[item.id], AbortSignal.timeout(60_000)));
      } catch {
        throw new Error("Golden download failed public HTTPS validation or transfer");
      }
      if (
        !Buffer.isBuffer(bytes) ||
        bytes.length < 1 ||
        bytes.length > LIMIT ||
        createHash("sha256").update(bytes).digest("hex") !== item.sha256
      ) {
        throw new Error("Golden bytes do not match the locked size or SHA256");
      }
      fs.writeFileSync(safePath(temporary, path.basename(item.path)), bytes, { flag: "wx" });
    }
    return runPrepare(root, { stages: ["goldens"], goldens: temporary });
  } finally {
    if (
      path.resolve(temporary).startsWith(path.resolve(parent) + path.sep) &&
      fs.realpathSync(temporary) === temporary
    )
      fs.rmSync(temporary, { recursive: true, force: true });
  }
}

export function prepareCiRuntime(root, env, platform = process.platform, runPrepare = prepare) {
  if (!env.GLINT_CHROME_PATH) throw new Error("Explicit installed local Chrome path is required");
  if (!["linux", "win32"].includes(platform))
    throw new Error("CI runtime preparation supports Linux and Windows");
  // Q26 owns the ten-style list, rendering, bridge builds and output validation.
  return runPrepare(
    root,
    parseArgs([
      `--stages=${platform === "win32" ? "styles,bridges" : "styles"}`,
      `--chrome=${env.GLINT_CHROME_PATH}`,
    ]),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3 || !["goldens", "runtime"].includes(process.argv[2]))
      throw new Error("Use goldens or runtime stage");
    const result =
      process.argv[2] === "goldens"
        ? await prepareCiGoldens(ROOT, process.env)
        : prepareCiRuntime(ROOT, process.env);
    console.log(JSON.stringify(result, null, 2));
  } catch {
    console.error(
      "CI fixture preparation blocked: configure owner-approved sources and installed tools; verify locked hashes. No tests were skipped.",
    );
    process.exitCode = 1;
  }
}
