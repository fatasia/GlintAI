import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, parse, resolve, sep } from "node:path";

function packageRoot(require, name) {
  let entry;
  try { entry = require.resolve(`${name}/package.json`); }
  catch { entry = require.resolve(name); }
  let root = dirname(realpathSync(entry));
  for (;;) {
    const manifest = join(root, "package.json");
    if (existsSync(manifest)) {
      const value = JSON.parse(readFileSync(manifest, "utf8"));
      if (value.name === name) return { root, manifest, value };
    }
    if (root === parse(root).root) throw new Error(`Cannot locate runtime package: ${name}`);
    root = dirname(root);
  }
}

/** Copy file-relative runtime packages, including licenses, without pnpm store links.
 * Shared versions stay flat; conflicting dependency versions remain nested under their parent.
 * No install scripts, credentials, dev dependencies or network access.
 */
export function copyDesktopServiceDependencies(repo, destination) {
  const modules = resolve(destination, "node_modules"), installed = new Map(), receipts = [];
  mkdirSync(modules, { recursive: true });
  function copy(name, require, parent, ancestry = new Set()) {
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) throw new Error("Invalid runtime package name");
    const source = packageRoot(require, name), identity = `${name}@${source.value.version}`;
    if (ancestry.has(identity)) return;
    const shared = installed.get(name);
    if (shared === identity) return;
    const base = shared ? join(parent, "node_modules") : modules;
    const target = resolve(base, ...name.split("/"));
    if (!target.startsWith(modules + sep)) throw new Error("Runtime dependency escaped its output directory");
    if (existsSync(target)) throw new Error(`Runtime dependency destination already exists: ${name}`);
    mkdirSync(dirname(target), { recursive: true });
    const nestedModules = join(source.root, "node_modules");
    cpSync(source.root, target, { recursive: true, dereference: true,
      filter: file => resolve(file) !== nestedModules && !resolve(file).startsWith(nestedModules + sep) });
    if (!shared) installed.set(name, identity);
    receipts.push({ name, version: source.value.version });
    const next = new Set(ancestry); next.add(identity);
    const local = createRequire(source.manifest);
    for (const dependency of Object.keys(source.value.dependencies ?? {})) copy(dependency, local, target, next);
    for (const dependency of Object.keys(source.value.optionalDependencies ?? {})) {
      try { local.resolve(dependency); } catch { continue; }
      if (!(dependency in (source.value.dependencies ?? {}))) copy(dependency, local, target, next);
    }
  }
  copy("jsdom", createRequire(join(repo, "apps/web/package.json")), resolve(destination));
  return receipts;
}
