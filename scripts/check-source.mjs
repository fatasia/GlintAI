import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const root = fileURLToPath(new URL("../", import.meta.url));
const inventory = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, windowsHide: true });
if (inventory.status !== 0) throw new Error("Cannot read source inventory");
const files = [...new Set(inventory.stdout.toString("utf8").split("\0").filter(Boolean))];
const findings = [];
let total = 0;
for (const file of files) {
  const target = path.resolve(root, file);
  if (!target.startsWith(root) || !fs.existsSync(target)) continue;
  const stat = fs.lstatSync(target); total += stat.size;
  if (!stat.isFile() || stat.isSymbolicLink()) { findings.push({ file, reason: "not a regular file" }); continue; }
  if (stat.size > 10 * 1024 * 1024) findings.push({ file, reason: "source file exceeds 10 MiB" });
  if (/(^|\/)(?:\.env(?:\..*)?|[^/]+\.(?:pem|key))$/i.test(file) && !file.endsWith(".env.example")) findings.push({ file, reason: "credential file" });
  if (/\.(?:png|webp|glb|bin|ktx2)$/i.test(file)) continue;
  const text = fs.readFileSync(target, "utf8");
  if (/gh[pousr]_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9_-]{40,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) findings.push({ file, reason: "possible secret token/key" });
}
console.log(JSON.stringify({ files: files.length, sourceBytes: total, findings, scope: "High-confidence token/file checks; not a comprehensive secrets audit", passed: !findings.length }, null, 2));
if (findings.length) process.exitCode = 1;
