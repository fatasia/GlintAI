import fs from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { packageVersion, ffmpegIdentity } from "./native-cache";
import { browserIdentity, findSystemBrowser } from "./direct-browser/host";
import { readArg } from "./glint-runtime";

/**
 * CREATE-11 渲染环境指纹：把「这个工程会被什么环境渲染」变成可检查的 JSON。
 * 快照固定不了字体文件与渲染器二进制，但可以让它们可追溯——升级或换机后
 * 主题字体栈的命中情况一目了然，不再静默替换字体。
 */

const FONT_REGISTRY_KEYS = [
  "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts",
  "HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts",
];

function registeredFontNames(): string[] {
  if (process.platform !== "win32") {
    const result = spawnSync("fc-list", ["--format=%{family}\n"], { encoding: "utf8", timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
    if (result.status !== 0) return [];
    return [...new Set(result.stdout.split(/[\r\n,]+/).map(name => name.trim()).filter(Boolean))];
  }
  const names: string[] = [];
  for (const key of FONT_REGISTRY_KEYS) {
    const result = spawnSync("reg", ["query", key], { encoding: "utf8", windowsHide: true });
    if (result.status !== 0) continue;
    for (const line of result.stdout.split(/\r?\n/)) {
      const match = /^\s{4}(.+?)\s+(?:\(TrueType\)|\(OpenType\)|\(TrueType 字体\)|\(OpenType 字体\))/.exec(line);
      if (match?.[1]) names.push(match[1]);
    }
  }
  return names;
}

function systemFontFiles(): string[] {
  const roots = process.platform === "win32"
    ? [path.join(process.env.WINDIR ?? "C:\\Windows", "Fonts")]
    : ["/usr/share/fonts", "/usr/local/share/fonts", path.join(os.homedir(), ".local/share/fonts"), path.join(os.homedir(), ".fonts")];
  const files: string[] = [];
  const walk = (directory: string, depth: number) => {
    if (depth > 2) return;
    let names: string[];
    try { names = fs.readdirSync(directory); } catch { return; }
    for (const name of names) {
      const file = path.join(directory, name);
      let stat: fs.Stats;
      try { stat = fs.lstatSync(file); } catch { continue; }
      if (stat.isDirectory()) walk(file, depth + 1);
      else if (/\.(ttf|ttc|otf)$/i.test(name)) files.push(`${name}:${stat.size}`);
    }
  };
  for (const root of roots) walk(root, 0);
  return files;
}

/** Query installed family metadata; filenames are only a fallback when metadata is unavailable. */
function fontAvailability(families: string[]): Array<{ family: string; available: boolean; via: string | null }> {
  if (!families.length) return [];
  const registry = registeredFontNames();
  const files = registry.length ? [] : systemFontFiles();
  return families.map(family => {
    const needle = family.trim().toLowerCase();
    if (!needle) return { family, available: false, via: null };
    const hit = registry.find(name => name.toLowerCase() === needle);
    if (hit) return { family, available: true, via: hit };
    const fileHit = files.find(file => file.toLowerCase().includes(needle));
    return fileHit ? { family, available: true, via: fileHit } : { family, available: false, via: null };
  });
}

type FontLockEntry = { name: string; sha256: string };

/** A lock records file bytes, not a claim about family selection or font licenses. */
function fontEntries(files: string[]): FontLockEntry[] {
  const seen = new Set<string>();
  return files.map(file => {
    const name = path.basename(file);
    if (!/\.(ttf|ttc|otf|woff2?)$/i.test(name)) throw new Error(`不支持的字体文件：${name}`);
    const key = name.toLowerCase();
    if (seen.has(key)) throw new Error(`字体文件名重复：${name}；请使用不同名称`);
    seen.add(key);
    try {
      if (!fs.statSync(file).isFile()) throw new Error("not a file");
      return { name, sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex") };
    } catch { throw new Error(`无法读取字体文件：${file}；请检查路径和读取权限`); }
  }).sort((a, b) => a.name.localeCompare(b.name, "en"));
}

function parseFontLock(text: string): FontLockEntry[] {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("字体锁文件不是有效 JSON"); }
  const lock = value as { version?: unknown; files?: unknown } | null;
  if (!lock || lock.version !== 1 || !Array.isArray(lock.files) || !lock.files.length || lock.files.length > 1000) throw new Error("字体锁文件格式无效");
  const seen = new Set<string>();
  for (const item of lock.files) {
    if (!item || typeof item.name !== "string" || !/^[^\\/]+\.(ttf|ttc|otf|woff2?)$/i.test(item.name) || typeof item.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(item.sha256) || seen.has(item.name.toLowerCase())) throw new Error("字体锁文件包含无效或重复的条目");
    seen.add(item.name.toLowerCase());
  }
  return lock.files as FontLockEntry[];
}

export function runRenderEnv(args: string[]): void {
  const createLock = readArg(args, "font-lock-create");
  const verifyLock = readArg(args, "font-lock-verify");
  if (createLock !== undefined || verifyLock !== undefined) {
    if (createLock !== undefined && verifyLock !== undefined) throw new Error("创建与验证字体锁不能同时使用");
    const lockPath = createLock ?? verifyLock;
    if (!lockPath?.trim()) throw new Error("请指定字体锁文件路径");
    const paths = args.filter(arg => arg.startsWith("--font-file=")).map(arg => arg.slice("--font-file=".length));
    if ((createLock !== undefined && !paths.length) || paths.some(file => !file.trim())) throw new Error("创建字体锁时请至少提供一个 --font-file=<本地字体文件>");
    const actual = fontEntries(paths);
    if (createLock !== undefined) {
      try { fs.writeFileSync(lockPath, JSON.stringify({ version: 1, files: actual }, null, 2) + "\n", { flag: "wx" }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`字体锁文件已存在，不会覆盖：${lockPath}`);
        throw error;
      }
      console.log(JSON.stringify({ status: "created", files: actual, note: "仅记录文件内容，不复制字体；请自行核实授权。渲染器未绑定这些文件。" }, null, 2));
    } else {
      let text: string;
      try { text = fs.readFileSync(lockPath, "utf8"); } catch { throw new Error(`无法读取字体锁文件：${lockPath}`); }
      const expected = parseFontLock(text);
      const byName = new Map(actual.map(item => [item.name.toLowerCase(), item]));
      const results = expected.map(item => {
        const found = byName.get(item.name.toLowerCase());
        return { name: item.name, status: !found ? "missing" : found.sha256 !== item.sha256 ? "mismatch" : "match" };
      });
      const unexpected = actual.filter(item => !expected.some(entry => entry.name.toLowerCase() === item.name.toLowerCase())).map(item => item.name);
      const ok = results.every(item => item.status === "match") && unexpected.length === 0;
      console.log(JSON.stringify({ status: ok ? "match" : "mismatch", files: results, unexpected, note: "仅验证文件字节，不保证字体授权、实际字体选择或跨机器像素一致。" }, null, 2));
      if (!ok) process.exitCode = 1;
    }
    return;
  }
  const fontsArg = readArg(args, "fonts");
  const families = fontsArg ? fontsArg.split(",").map(item => item.trim()).filter(Boolean) : [];
  const browserFile = (() => { try { return findSystemBrowser(); } catch { return null; } })();
  const output = {
    platform: process.platform,
    node: process.version,
    ffmpeg: ffmpegIdentity() || "missing",
    browser: browserIdentity() ?? "missing",
    browserPath: browserFile ?? "missing",
    resvg: packageVersion("@resvg/resvg-js") ?? "unknown",
    designTokens: packageVersion("@glintai/design-tokens") ?? "unknown",
    scenescript: packageVersion("@glintai/scenescript") ?? "unknown",
    ...(families.length ? { fonts: fontAvailability(families) } : {}),
    fontsHash: createHash("sha256").update(systemFontFiles().sort().join("\n")).digest("hex").slice(0, 16),
  };
  console.log(JSON.stringify(output, null, 2));
}
