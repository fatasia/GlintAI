import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STYLES = ['glint-dark', 'glint-light', 'whiteboard', 'blackboard-tech', 'cream-editorial', 'blueprint', 'bold-poster', 'mint-clean', 'retro-news', 'hand-note'];
const MAX_FILE = 64 * 1024 * 1024;

export function parseArgs(args) {
  const options = {};
  for (const arg of args) {
    const match = /^--(stages|goldens|chrome|styles)=(.+)$/.exec(arg);
    if (!match || options[match[1]]) throw new Error('Use unique --stages=goldens,styles,bridges --goldens=DIR --chrome=FILE --styles=ID,...');
    options[match[1]] = match[2];
  }
  const stages = options.stages?.split(',') ?? [];
  const styles = options.styles?.split(',') ?? STYLES;
  if (!stages.length || new Set(stages).size !== stages.length || stages.some(s => !['goldens', 'styles', 'bridges'].includes(s))) throw new Error('Select explicit stages: goldens,styles,bridges');
  if (!styles.length || styles.length > 10 || new Set(styles).size !== styles.length || styles.some(s => !STYLES.includes(s))) throw new Error('Unknown or duplicate style');
  if (stages.includes('goldens') && !options.goldens) throw new Error('--goldens is required');
  if (stages.includes('styles') && !options.chrome) throw new Error('--chrome must name an installed local browser');
  if ((!stages.includes('styles') && (options.styles || options.chrome)) || (!stages.includes('goldens') && options.goldens)) throw new Error('Option does not belong to selected stages');
  return { stages, styles, goldens: options.goldens, chrome: options.chrome };
}

// Reject junction/symlink ancestors too, not just the final file.
export function safePath(root, relative) {
  const base = path.resolve(root), target = path.resolve(base, relative);
  if (target === base || !target.startsWith(base + path.sep)) throw new Error('Path escapes fixture root');
  let cursor = target;
  while (true) {
    let stat;
    try { stat = fs.lstatSync(cursor); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat?.isSymbolicLink()) throw new Error('Fixture paths cannot contain links');
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return target;
}

export function digest(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_FILE) throw new Error('Invalid fixture file or size');
  return { bytes: stat.size, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
}

/** Browser input is user-selected, not a confined fixture output. */
export function resolveInstalledBrowser(file) {
  const resolved = fs.realpathSync(path.resolve(file));
  if (!fs.statSync(resolved).isFile()) throw new Error('Browser must be a regular file');
  // Windows X_OK checks existence, not POSIX execute bits; launch still validates it.
  fs.accessSync(resolved, fs.constants.X_OK);
  return resolved;
}

export function childEnvironment(source = process.env) {
  const env = { ...source };
  for (const key of Object.keys(env)) if (/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|OPENAI|ANTHROPIC|GLINT_.*(ENDPOINT|MODEL|BUNDLE|BRIDGE)|NODE_OPTIONS|CARGO_TARGET_DIR|RUSTC_WRAPPER|RUSTFLAGS/i.test(key)) delete env[key];
  return { ...env, GLINT_COMPOSER_AI: '0', CARGO_NET_OFFLINE: 'true', CARGO_BUILD_JOBS: '2', npm_config_offline: 'true' };
}

function command(command, args, cwd, env, timeout = 120000) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit', windowsHide: true, timeout });
  if (result.error || result.status !== 0) throw new Error(`Fixture command failed: ${path.basename(command)} (exit ${result.status ?? 'none'})`);
}

function readJson(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('Invalid fixture metadata');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function prepareGoldens(root, source) {
  const config = readJson(safePath(root, 'apps/studio/scripts/reference-eval-fixtures.json'));
  const fixtures = config.cases;
  if (!Array.isArray(fixtures) || fixtures.length !== 4) throw new Error('Expected the four locked reference fixtures');
  // Validate every source and destination before copying any bytes.
  const planned = fixtures.map(item => {
    if (typeof item.path !== 'string' || !/^evidence\/(SKILL-01|MOTION-05)\//.test(item.path) || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('Invalid locked fixture');
    const input = safePath(source, path.basename(item.path)), output = safePath(root, item.path);
    const measured = digest(input);
    if (measured.bytes > 1024 * 1024 || measured.sha256 !== item.sha256) throw new Error(`Golden SHA mismatch: ${item.id}`);
    if (fs.existsSync(output) && digest(output).sha256 !== item.sha256) throw new Error(`Existing golden differs: ${item.id}`);
    return { input, output, path: item.path, ...measured };
  });
  for (const item of planned) if (!fs.existsSync(item.output)) {
    fs.mkdirSync(path.dirname(item.output), { recursive: true });
    fs.copyFileSync(item.input, item.output, fs.constants.COPYFILE_EXCL);
    if (digest(item.output).sha256 !== item.sha256) throw new Error('Golden changed while copying');
  }
  return planned.map(({ input, output, ...entry }) => entry);
}

function receiptPath(root, name) { return safePath(root, `outputs/test-fixtures/${name}.json`); }
function verifyReceipt(root, name, expected) {
  const receipt = receiptPath(root, name);
  if (!fs.existsSync(receipt)) return false;
  const value = readJson(receipt);
  if (value.version !== 1 || !Array.isArray(value.files) || value.files.length !== expected.length || value.files.some((f, i) => f.path !== expected[i])) throw new Error('Fixture receipt set differs');
  for (const file of value.files) {
    const current = digest(safePath(root, file.path));
    if (current.sha256 !== file.sha256 || current.bytes !== file.bytes) throw new Error(`Fixture changed: ${file.path}`);
  }
  return true;
}
function saveReceipt(root, name, paths) {
  const files = paths.map(relative => ({ path: relative, ...digest(safePath(root, relative)) }));
  fs.writeFileSync(receiptPath(root, name), JSON.stringify({ version: 1, files }, null, 2) + '\n', { flag: 'wx' });
  return files;
}

function prepareStyles(root, options, run, env) {
  const paths = ['outputs/style-samples/manifest.json', ...options.styles.flatMap(id => [`outputs/style-samples/${id}.mp4`, `outputs/style-samples/${id}.project.json`])];
  if (verifyReceipt(root, 'styles', paths)) return { stage: 'styles', status: 'verified' };
  const output = safePath(root, 'outputs/style-samples');
  if (fs.existsSync(output)) throw new Error('Style output already exists without matching receipt; use a fresh clone, no files overwritten');
  const chrome = resolveInstalledBrowser(options.chrome);
  run('ffmpeg', ['-version'], root, env); run('ffprobe', ['-version'], root, env);
  const loader = createRequire(path.join(root, 'apps/studio/package.json')).resolve('tsx/esm');
  run(process.execPath, ['--import', pathToFileURL(loader).href, path.join(root, 'scripts/render-style-samples.mjs'), `--only=${options.styles.join(',')}`, '--concurrency=1', '--skip-sheet'], root, { ...env, GLINT_CHROME_EXECUTABLE: chrome }, 1800000);
  const manifest = readJson(safePath(root, paths[0]));
  if (manifest.entries?.length !== options.styles.length || options.styles.some(id => !manifest.entries.some(e => e.id === id && e.status === 'done'))) throw new Error('Style generator did not complete requested set');
  return { stage: 'styles', status: 'prepared', files: saveReceipt(root, 'styles', paths) };
}

function prepareBridges(root, run, env) {
  if (process.platform !== 'win32') throw new Error('These bridge fixtures require Windows');
  const paths = ['debug', 'release'].map(profile => `apps/desktop/secure-assets/target/${profile}/glint-secure-assets.exe`);
  if (verifyReceipt(root, 'bridges', paths)) return { stage: 'bridges', status: 'verified' };
  if (paths.some(relative => fs.existsSync(safePath(root, relative)))) throw new Error('Bridge exists without matching receipt; use a fresh clone');
  const manifest = safePath(root, 'apps/desktop/secure-assets/Cargo.toml');
  const target = safePath(root, 'apps/desktop/secure-assets/target');
  for (const profile of ['debug', 'release']) run('cargo', ['build', '--offline', '--locked', '--manifest-path', manifest, '--target-dir', target, ...(profile === 'release' ? ['--release'] : [])], root, env, 600000);
  return { stage: 'bridges', status: 'prepared', files: saveReceipt(root, 'bridges', paths) };
}

export function prepare(root, options, run = command) {
  const state = safePath(root, 'outputs/test-fixtures');
  fs.mkdirSync(state, { recursive: true });
  const lock = safePath(root, 'outputs/test-fixtures/prepare.lock');
  const fd = fs.openSync(lock, 'wx');
  try {
    const env = childEnvironment(), results = [];
    for (const stage of options.stages) {
      if (stage === 'goldens') results.push({ stage, status: 'verified', files: prepareGoldens(root, options.goldens) });
      if (stage === 'styles') results.push(prepareStyles(root, options, run, env));
      if (stage === 'bridges') results.push(prepareBridges(root, run, env));
    }
    return { version: 1, stages: results, fullStyles: options.stages.includes('styles') && options.styles.length === 10 };
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(prepare(ROOT, parseArgs(process.argv.slice(2))), null, 2)); }
  catch (error) { console.error(error instanceof Error ? error.message : 'Fixture preparation failed'); process.exitCode = 1; }
}

