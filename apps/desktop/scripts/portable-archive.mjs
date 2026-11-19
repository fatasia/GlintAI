import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync, readSync, statSync } from "node:fs";
import { dirname } from "node:path";

/** Create a new archive; report PowerShell and output validation failures. */
export function createPortableArchive(output, archive, spawnImpl = spawnSync) {
  if (existsSync(archive)) throw new Error("Archive already exists; choose a new path");
  mkdirSync(dirname(archive), { recursive: true });
  const result = spawnImpl("powershell", ["-NoProfile", "-Command",
    "$ErrorActionPreference = 'Stop'; Get-ChildItem -LiteralPath $env:GLINT_ARCHIVE_INPUT -Force -ErrorAction Stop | Compress-Archive -DestinationPath $env:GLINT_ARCHIVE_TARGET -ErrorAction Stop"],
    { stdio: "inherit", env: { ...process.env, GLINT_ARCHIVE_INPUT: output, GLINT_ARCHIVE_TARGET: archive } });
  if (result.error || result.status !== 0) throw new Error("Compress-Archive failed");
  let fd;
  try {
    const info = statSync(archive), signature = Buffer.alloc(4);
    fd = openSync(archive, "r");
    if (!info.isFile() || info.size < 4 || readSync(fd, signature, 0, 4, 0) !== 4 || !signature.equals(Buffer.from([80, 75, 3, 4]))) throw new Error("Invalid ZIP archive");
  } catch { throw new Error("Compress-Archive did not create a valid ZIP"); }
  finally { if (fd !== undefined) closeSync(fd); }
}
