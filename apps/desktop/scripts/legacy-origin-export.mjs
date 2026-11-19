import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// Maintenance tool: reads a copy through Chromium, never parses LevelDB document values.
// This allowlist intentionally excludes provider credentials and unrelated browser storage.
import { recoveryKey } from "../../web/src/legacy-recovery-keys.mjs";
export { recoveryKey };
export function discoverLegacyPorts(directory) {
  const ports = new Set();
  for (const name of fs.readdirSync(directory)) {
    if (!/\.(ldb|log)$/.test(name)) continue;
    const file = path.join(directory, name), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024 * 1024) throw new Error("Unsafe or oversized storage file");
    for (const match of fs.readFileSync(file).toString("latin1").matchAll(/http:\/\/127\.0\.0\.1:(\d{2,5})(?!\d)/g)) {
      const port = Number(match[1]); if (port >= 1024 && port <= 65535) ports.add(port);
    }
  }
  return [...ports].sort((a,b) => a-b);
}
export async function exportLegacyOrigins({ profileDir, executablePath, outputDir, ports }) {
  const source = path.resolve(profileDir, "Default/Local Storage/leveldb"), output = path.resolve(outputDir);
  const relative = path.relative(path.resolve(profileDir), output);
  if (!relative || relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)) throw new Error("Recovery output must be outside the original profile");
  if (fs.existsSync(output)) throw new Error("Choose a new recovery output directory; existing backups are never overwritten");
  const chosen = [...new Set(ports ?? discoverLegacyPorts(source))];
  if (chosen.length > 100 || chosen.some(port => !Number.isInteger(port) || port < 1024 || port > 65535)) throw new Error("Invalid legacy ports");
  if (!chosen.length) throw new Error("No origins found; supply known ports explicitly");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "glint-legacy-export-"));
  let browser;
  try {
    const target = path.join(temporary, "Default/Local Storage/leveldb"); fs.mkdirSync(target, { recursive: true });
    const manifest = () => fs.readdirSync(source).filter(name => name !== "LOCK").sort().map(name => {
      const stat = fs.lstatSync(path.join(source, name));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024 * 1024) throw new Error("Unsafe or oversized storage file");
      return { name, size: stat.size, mtime: stat.mtimeMs };
    });
    const before = manifest();
    for (const entry of before) fs.copyFileSync(path.join(source, entry.name), path.join(target, entry.name));
    if (JSON.stringify(before) !== JSON.stringify(manifest())) throw new Error("Storage changed during copy; close the old client and retry");
    const puppeteer = createRequire(new URL("../../studio/package.json", import.meta.url))("puppeteer-core");
    browser = await puppeteer.launch({ executablePath, headless: true, userDataDir: temporary, args: ["--disable-background-networking"] });
    const page = await browser.newPage(); await page.setRequestInterception(true);
    page.on("request", request => new URL(request.url()).hostname === "127.0.0.1" ? request.continue() : request.abort());
    fs.mkdirSync(output, { recursive: true });
    const results = [];
    for (const port of chosen) {
      const server = http.createServer((_req, res) => {
        res.setHeader("Content-Type", "text/html;charset=utf-8");
        res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
        res.end("<!doctype html><title>Glint recovery</title>");
      });
      try {
        await new Promise((resolve,reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
        await page.goto(`http://127.0.0.1:${port}`, { timeout: 15000 });
        const keys = await page.evaluate(() => Object.keys(localStorage));
        const selected = keys.filter(recoveryKey);
        const values = await page.evaluate(keys => Object.fromEntries(keys.map(key => [key, localStorage.getItem(key)])), selected);
        const snapshot = { version: 1, origin: `http://127.0.0.1:${port}`, exportedAt: new Date().toISOString(), values };
        fs.writeFileSync(path.join(output, `origin-${port}.json`), JSON.stringify(snapshot, null, 2), { flag: "wx", mode: 0o600 });
        results.push({ port, keys: selected.length, skipped: keys.length-selected.length });
      } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    }
    fs.writeFileSync(path.join(output, "manifest.json"), JSON.stringify({ version:1, results, note:"Per-origin localStorage only; media files and IndexedDB are not included. Discovery may include deleted origins or miss compressed metadata. Originals are unchanged." }, null, 2), {flag:"wx",mode:0o600});
    return results;
  } finally {
    await browser?.close();
    // Only the unique temporary copy created above is removed; never the supplied profile.
    if (path.dirname(path.resolve(temporary)) !== path.resolve(os.tmpdir()) || !path.basename(temporary).startsWith("glint-legacy-export-")) throw new Error("Unsafe temporary cleanup path");
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [profileDir, executablePath, outputDir, portList] = process.argv.slice(2);
  if (!profileDir || !executablePath || !outputDir) throw new Error("Usage: node legacy-origin-export.mjs PROFILE_DIR CHROMIUM_EXE NEW_OUTPUT_DIR [PORT,PORT]");
  const results = await exportLegacyOrigins({profileDir,executablePath,outputDir,ports:portList?.split(',').map(Number)});
  console.log(JSON.stringify({outputDir,results}));
}
