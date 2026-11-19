import { access, lstat, stat as fileStat, open, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { demand, LocalAgentError } from "./local-agent-common.mjs";

const require = createRequire(import.meta.url);
export const CATALOG = Object.freeze([
  { id: "claude", name: "Claude Code", commands: ["claude"], package: "@agentclientprotocol/claude-agent-acp", entry: "dist/index.js", version: "0.99.1", args: [] },
  { id: "codex", name: "Codex", commands: ["codex"], package: "@agentclientprotocol/codex-acp", entry: "dist/index.js", version: "2.5.0", args: [] },
  { id: "opencode", name: "OpenCode", commands: ["opencode"], args: ["acp"] },
  { id: "qwen", name: "Qwen Code", commands: ["qwen"], args: ["--acp"] },
  { id: "kimi", name: "Kimi Code", commands: ["kimi"], args: ["acp"] },
  { id: "copilot", name: "GitHub Copilot", commands: ["copilot"], args: ["--acp", "--stdio"] },
]);
export function catalogEntry(id) {
  const entry = CATALOG.find(item => item.id === id);
  demand(entry, "unknown-agent", "请选择固定目录中的本地代理。"); return entry;
}
async function cliFile(file) {
  const stat = await fileStat(file);
  demand(stat.isFile(), "invalid-path", "请选择 CLI 可执行文件，而非目录。");
  demand(!/(?:desktop|electron|launcher|uninstall|setup|gui)/i.test(path.basename(file)), "invalid-path", "不能将桌面 GUI 当作 ACP CLI。");
  if (path.extname(file).toLowerCase() === ".exe") {
    const handle = await open(file, "r");
    try {
      const dos = Buffer.alloc(64); const header = await handle.read(dos, 0, 64, 0);
      demand(header.bytesRead === 64 && dos.toString("ascii", 0, 2) === "MZ" && dos.readUInt32LE(60) <= stat.size - 96, "invalid-path", "CLI 不是有效的 Windows PE 程序。");
      const pe = Buffer.alloc(96); await handle.read(pe, 0, 96, dos.readUInt32LE(60));
      demand(pe.toString("ascii", 0, 4) === "PE\0\0" && pe.readUInt16LE(92) === 3, "invalid-path", "请选择控制台 CLI，不支持 GUI 可执行文件。");
    } finally { await handle.close(); }
  }
}
export async function resolveCommand(file, args = []) {
  demand(typeof file === "string" && path.isAbsolute(file) && !file.includes("\0"), "invalid-path", "代理路径必须是手动选择的绝对路径。");
  await cliFile(file);
  const extension = path.extname(file).toLowerCase();
  if ([".cmd", ".bat", ".ps1"].includes(extension)) {
    const stat = await lstat(file);
    demand(stat.size <= 16384, "invalid-shim", "CLI shim 过大，无法安全识别。");
    const content = await readFile(file, "utf8");
    const match = content.match(/["'](?:%~dp0|%dp0%|\$basedir)[\\/]([^"'\r\n]+\.(?:m?js|cjs))["']/i);
    demand(match, "invalid-shim", "无法识别此 CLI shim；请直接选择其 JS 入口或控制台程序。");
    const target = path.resolve(path.dirname(file), match[1].replace(/[\\/]/g, path.sep));
    await cliFile(target); return { command: process.execPath, args: [target, ...args], path: file };
  }
  demand(["", ".exe", ".com", ".js", ".mjs", ".cjs"].includes(extension), "invalid-path", "不支持此 CLI 文件类型。");
  return [".js", ".mjs", ".cjs"].includes(extension)
    ? { command: process.execPath, args: [file, ...args], path: file } : { command: file, args: [...args], path: file };
}
async function bundled(entry) {
  if (!entry.package) return null;
  if (typeof __GLINT_DESKTOP_BUNDLE__ !== "undefined" && __GLINT_DESKTOP_BUNDLE__) {
    const script = fileURLToPath(new URL(`./agents/${entry.id}.mjs`, import.meta.url));
    await access(script);
    return { command: process.execPath, args: [script], path: script };
  }
  try {
    const base = path.dirname(require.resolve(`${entry.package}/package.json`));
    await access(path.join(base, entry.entry));
    const manifest = JSON.parse(await readFile(path.join(base, "package.json"), "utf8"));
    demand(manifest.version === entry.version, "adapter-version", "官方 ACP 适配器版本不匹配。");
    return { command: process.execPath, args: [path.join(base, entry.entry)], path: path.join(base, entry.entry) };
  } catch (error) { if (error.code === "MODULE_NOT_FOUND" || error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED") return null; throw error; }
}
export function createCatalog({ env = process.env, platform = process.platform, adapters = {} } = {}) {
  for (const key of Object.keys(adapters)) catalogEntry(key);
  const directories = [...new Set([
    ...(env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : path.delimiter),
    env.APPDATA && path.join(env.APPDATA, "npm"), env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Links"),
    path.join(env.HOME ?? env.USERPROFILE ?? os.homedir(), ".local", "bin"),
    path.join(env.HOME ?? env.USERPROFILE ?? os.homedir(), ".bun", "bin"),
    path.join(env.HOME ?? env.USERPROFILE ?? os.homedir(), ".cargo", "bin"),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs", "Claude"),
  ].filter(item => item && path.isAbsolute(item)))];
  async function withOfficialAdapter(entry, cli) {
    if (!entry.package) return cli;
    const adapter = await bundled(entry);
    demand(adapter, "adapter-missing", "缺少官方 ACP 适配器，请修复应用依赖。");
    const actual = cli.command === process.execPath && cli.args.length ? cli.args[0] : cli.command;
    return { ...adapter, path: cli.path, cliEnv: { [entry.id === "codex" ? "CODEX_PATH" : "CLAUDE_CODE_EXECUTABLE"]: actual } };
  }
  return async (id, selected) => {
    const entry = catalogEntry(id);
    if (selected) return withOfficialAdapter(entry, await resolveCommand(selected, entry.args));
    // Adapter injection is a trusted embedding/test option, never accepted from request JSON.
    if (adapters[id]) return resolveCommand(adapters[id].command, adapters[id].args ?? entry.args);
    let cli;
    for (const directory of directories) {
      for (const command of entry.commands) for (const extension of platform === "win32" ? [".cmd", ".exe", ".js", ""] : [""]) {
        const file = path.join(directory, command + extension);
        try { await access(file); cli = await resolveCommand(file, entry.args); break; } catch { /* only inspect fixed catalog candidates */ }
      }
      if (cli) break;
    }
    if (cli) return withOfficialAdapter(entry, cli);
    throw new LocalAgentError("not-installed", "未找到 ACP CLI；请安装官方代理后手动选择可执行文件。");
  };
}
