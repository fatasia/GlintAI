import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { childEnvironment, digest, parseArgs, prepare, prepareGoldens, safePath, resolveInstalledBrowser } from './prepare-test-fixtures.mjs';

const roots: string[] = [];
function temp() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glint-fixture-prep-')); roots.push(dir); return dir; }
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const root = temp(), source = temp();
  fs.mkdirSync(path.join(root, 'apps/studio/scripts'), { recursive: true });
  const cases = ['whiteboard', 'blackboard', 'dark', 'lottie'].map(id => {
    const bytes = Buffer.from(`original ${id}`); fs.writeFileSync(path.join(source, `${id}.mp4`), bytes);
    return { id, path: `evidence/SKILL-01/original/${id}.mp4`, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  fs.writeFileSync(path.join(root, 'apps/studio/scripts/reference-eval-fixtures.json'), JSON.stringify({ cases }));
  return { root, source, cases };
}

it('requires explicit unique stages and valid bounded options', () => {
  expect(() => parseArgs([])).toThrow(/explicit/);
  expect(() => parseArgs(['--stages=goldens'])).toThrow(/goldens/);
  expect(() => parseArgs(['--stages=styles'])).toThrow(/chrome/);
  expect(() => parseArgs(['--stages=bridges,bridges'])).toThrow();
  expect(() => parseArgs(['--stages=bridges', '--styles=blueprint'])).toThrow();
  expect(() => parseArgs(['--stages=styles', '--chrome=local', '--styles=../escape'])).toThrow();
  expect(parseArgs(['--stages=styles', '--chrome=local']).styles).toHaveLength(10);
});

it('copies all verified goldens exclusively and repeated preparation preserves files', () => {
  const { root, source, cases } = fixture();
  const run = vi.fn();
  const options = parseArgs(['--stages=goldens', `--goldens=${source}`]);
  expect(prepare(root, options, run).stages[0].files).toHaveLength(4);
  const before = cases.map(c => fs.statSync(path.join(root, c.path)).mtimeMs);
  prepare(root, options, run);
  expect(cases.map(c => fs.statSync(path.join(root, c.path)).mtimeMs)).toEqual(before);
  expect(run).not.toHaveBeenCalled();
  expect(fs.existsSync(path.join(root, 'outputs/test-fixtures/prepare.lock'))).toBe(false);
});

it('validates the whole input set before writing and rejects changed destination without overwrite', () => {
  const { root, source, cases } = fixture();
  fs.writeFileSync(path.join(source, 'lottie.mp4'), 'bad');
  expect(() => prepareGoldens(root, source)).toThrow(/SHA/);
  expect(fs.existsSync(path.join(root, cases[0].path))).toBe(false);
  fs.writeFileSync(path.join(source, 'lottie.mp4'), 'original lottie');
  prepareGoldens(root, source);
  fs.writeFileSync(path.join(root, cases[1].path), 'local change');
  expect(() => prepareGoldens(root, source)).toThrow(/differs/);
  expect(fs.readFileSync(path.join(root, cases[1].path), 'utf8')).toBe('local change');
});

it('rejects traversal, directories, oversized input and linked ancestor', () => {
  const root = temp(), outside = temp();
  expect(() => safePath(root, '../outside')).toThrow(/escapes/);
  expect(() => digest(outside)).toThrow(/Invalid/);
  const large = path.join(root, 'large'); const fd = fs.openSync(large, 'w'); fs.ftruncateSync(fd, 64 * 1024 * 1024 + 1); fs.closeSync(fd);
  expect(() => digest(large)).toThrow(/size/);
  fs.symlinkSync(outside, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  expect(() => safePath(root, 'link/file')).toThrow(/links/);
  fs.rmdirSync(outside);
  expect(() => safePath(root, 'link/file')).toThrow(/links/);
});

it('strips model credentials and override loaders while forcing offline local execution', () => {
  const env = childEnvironment({ PATH: 'local', GLINT_LLM_API_KEY: 'secret', OPENAI_BASE_URL: 'remote', ANTHROPIC_AUTH_TOKEN: 'secret', GLINT_MEDIA_ENDPOINT: 'remote', NODE_OPTIONS: '--import=other', GLINT_PREBUILT_BUNDLE: 'old', CARGO_TARGET_DIR: 'other', GLINT_COMPOSER_AI: '1' });
  expect(env).toEqual({ PATH: 'local', GLINT_COMPOSER_AI: '0', CARGO_NET_OFFLINE: 'true', CARGO_BUILD_JOBS: '2', npm_config_offline: 'true' });
});

it('does not dispatch a render for existing unreceipted output or missing Chrome', () => {
  const root = temp(), run = vi.fn();
  fs.mkdirSync(path.join(root, 'outputs/style-samples'), { recursive: true });
  expect(() => prepare(root, parseArgs(['--stages=styles', '--chrome=missing']), run)).toThrow(/already exists/);
  expect(run).not.toHaveBeenCalled();
  const fresh = temp();
  expect(() => prepare(fresh, parseArgs(['--stages=styles', '--chrome=missing']), run)).toThrow();
  expect(run).not.toHaveBeenCalled();
});

it('builds both bridge profiles offline, records outputs and detects later corruption', () => {
  const root = temp(), calls: string[][] = [];
  const run = (command: string, args: string[], cwd: string, env: Record<string, string>) => {
    expect(command).toBe('cargo'); expect(cwd).toBe(root); expect(env.CARGO_NET_OFFLINE).toBe('true');
    expect(args).toContain('--offline'); expect(args).toContain('--locked');
    calls.push(args);
    const profile = args.includes('--release') ? 'release' : 'debug';
    const output = path.join(root, `apps/desktop/secure-assets/target/${profile}/glint-secure-assets.exe`);
    fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, `built-${profile}`);
  };
  const options = parseArgs(['--stages=bridges']);
  if (process.platform !== 'win32') { expect(() => prepare(root, options, run)).toThrow(/Windows/); return; }
  expect(prepare(root, options, run).stages[0].status).toBe('prepared'); expect(calls).toHaveLength(2);
  expect(prepare(root, options, run).stages[0].status).toBe('verified'); expect(calls).toHaveLength(2);
  fs.writeFileSync(path.join(root, 'apps/desktop/secure-assets/target/debug/glint-secure-assets.exe'), 'tampered');
  expect(() => prepare(root, options, run)).toThrow(/changed/); expect(calls).toHaveLength(2);
});

it('preserves interrupted build output, releases own lock and refuses concurrent preparation', () => {
  const root = temp();
  fs.mkdirSync(path.join(root, 'outputs/test-fixtures'), { recursive: true });
  const lock = path.join(root, 'outputs/test-fixtures/prepare.lock'); fs.writeFileSync(lock, 'other');
  expect(() => prepare(root, parseArgs(['--stages=bridges']), vi.fn())).toThrow();
  expect(fs.readFileSync(lock, 'utf8')).toBe('other'); fs.unlinkSync(lock);
  const run = () => { throw new Error('offline cache missing'); };
  expect(() => prepare(root, parseArgs(['--stages=bridges']), run)).toThrow();
  expect(fs.existsSync(lock)).toBe(false);
});

it('dispatches only selected real-generator arguments and verifies generated style receipts', () => {
  const root = temp(), chrome = path.join(root, 'chrome.exe'); fs.writeFileSync(chrome, 'local browser');
  const pkg = path.join(root, 'apps/studio/node_modules/tsx'); fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'tsx', exports: { './esm': './esm.mjs' } }));
  fs.writeFileSync(path.join(pkg, 'esm.mjs'), '');
  const calls: string[] = [];
  const run = (command: string, args: string[], cwd: string, env: Record<string, string>) => {
    calls.push(command);
    if (command !== process.execPath) return;
    expect(cwd).toBe(root); expect(args).toContain('--only=whiteboard'); expect(args).toContain('--concurrency=1');
    expect(args).toContain('--skip-sheet'); expect(env.GLINT_CHROME_EXECUTABLE).toBe(chrome); expect(env.GLINT_COMPOSER_AI).toBe('0');
    const out = path.join(root, 'outputs/style-samples'); fs.mkdirSync(out);
    fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ entries: [{ id: 'whiteboard', status: 'done' }] }));
    fs.writeFileSync(path.join(out, 'whiteboard.mp4'), 'rendered-boundary-output');
    fs.writeFileSync(path.join(out, 'whiteboard.project.json'), '{}');
  };
  const options = parseArgs(['--stages=styles', `--chrome=${chrome}`, '--styles=whiteboard']);
  expect(prepare(root, options, run)).toMatchObject({ fullStyles: false, stages: [{ status: 'prepared' }] });
  expect(calls).toEqual(['ffmpeg', 'ffprobe', process.execPath]);
  expect(prepare(root, options, run).stages[0].status).toBe('verified'); expect(calls).toHaveLength(3);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'outputs/style-samples/manifest.json'), 'utf8'));
  expect(manifest.entries[0]).not.toHaveProperty('sha256');
});

it('resolves a selected large browser through a linked directory without reading its bytes', () => {
  const root = temp(), installed = temp(), file = path.join(installed, 'browser');
  const fd = fs.openSync(file, 'w'); fs.ftruncateSync(fd, 64 * 1024 * 1024 + 1); fs.closeSync(fd);
  fs.chmodSync(file, 0o755);
  fs.symlinkSync(installed, path.join(root, 'selected'), process.platform === 'win32' ? 'junction' : 'dir');
  const read = vi.spyOn(fs, 'readFileSync');
  try {
    expect(resolveInstalledBrowser(path.join(root, 'selected/browser'))).toBe(fs.realpathSync(file));
    expect(read).not.toHaveBeenCalled();
  } finally { read.mockRestore(); }
  expect(() => digest(file)).toThrow(/size/);
  expect(() => safePath(root, 'selected/browser')).toThrow(/links/);
});

it('rejects missing and directory browser entries without treating them as executables', () => {
  const root = temp();
  expect(() => resolveInstalledBrowser(path.join(root, 'missing'))).toThrow(/ENOENT/);
  expect(() => resolveInstalledBrowser(root)).toThrow(/regular file/);
});

it('checks execute access on the resolved file', () => {
  const root = temp(), file = path.join(root, 'browser'); fs.writeFileSync(file, 'not launched');
  const access = vi.spyOn(fs, 'accessSync').mockImplementation(() => { throw new Error('EACCES'); });
  try {
    expect(() => resolveInstalledBrowser(file)).toThrow('EACCES');
    expect(access).toHaveBeenCalledWith(fs.realpathSync(file), fs.constants.X_OK);
  } finally { access.mockRestore(); }
});
