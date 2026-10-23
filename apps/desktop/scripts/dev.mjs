import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, realpathSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function resolveExecutable(value, env = process.env) {
  const extensions = process.platform === 'win32' ? ['', '.exe'] : [''];
  const candidates = isAbsolute(value) || /[\\/]/.test(value)
    ? [resolve(value)]
    : (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean).map(dir => join(dir, value));
  for (const candidate of candidates) {
    for (const extension of extensions) {
      if (existsSync(candidate + extension)) return realpathSync(candidate + extension);
    }
  }
  throw new Error(`Executable not found: ${value}. Install Node.js/Rust or configure GLINT_DESKTOP_NODE with an absolute node.exe path.`);
}

export function developmentEnvironment(repo = resolve(desktopDir, '../..'), env = process.env) {
  const required = ['apps/web/dist/index.html', 'apps/web/server/desktop-service.mjs'];
  for (const file of required) {
    if (!existsSync(join(repo, file))) {
      throw new Error(`Missing ${file}. Install repository dependencies and build the web UI first (pnpm --filter glint-web build). This launcher is development-only.`);
    }
  }
  const requireWeb = createRequire(join(repo, 'apps/web/package.json'));
  let tsx;
  try {
    tsx = pathToFileURL(requireWeb.resolve('tsx')).href;
  } catch (cause) {
    throw new Error('Cannot resolve apps/web tsx loader. Run pnpm install in the repository first.', { cause });
  }
  return {
    ...env,
    GLINT_DESKTOP_REPO: realpathSync(repo),
    GLINT_DESKTOP_NODE: resolveExecutable(env.GLINT_DESKTOP_NODE || process.execPath, env),
    GLINT_DESKTOP_TSX: tsx,
  };
}

function main() {
  if (process.platform !== 'win32') throw new Error('This minimal development host currently supports Windows only.');
  if (process.argv.length > 2) throw new Error('This launcher accepts no arguments. Release packaging is not implemented.');
  const env = developmentEnvironment();
  const cargo = resolveExecutable('cargo', env);
  const child = spawn(cargo, ['run', '--manifest-path', join(desktopDir, 'Cargo.toml')], {
    cwd: desktopDir, env, stdio: 'inherit', shell: false,
  });
  child.once('error', error => {
    console.error(`Cannot launch Cargo: ${error.message}`);
    process.exitCode = 1;
  });
  child.once('exit', code => { process.exitCode = code ?? 1; });
  // Ctrl+C reaches the shared Windows console process group, including Cargo and the host.
  // The host's Job Object kills the Node service even if graceful shutdown is interrupted.
  process.on('SIGINT', () => {});
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
