import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { expect, it } from "vitest";
import { findSystemBrowser } from "../../studio/scripts/direct-browser/host";

type Proc = { ProcessId: number; ParentProcessId: number; Name: string; CommandLine: string | null; CreationDate: string };
function processes(): Proc[] {
  const json = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,CreationDate | ConvertTo-Json -Compress"], { encoding: "utf8", windowsHide: true });
  // Some Windows hosts append a diagnostic line after PowerShell exits;
  // ConvertTo-Json -Compress itself returns one JSON line.
  const parsed = JSON.parse(json.split(/\r?\n/, 1)[0]!) as Proc | Proc[]; return Array.isArray(parsed) ? parsed : [parsed];
}
function descendants(all: Proc[], root: number): Proc[] {
  const ids = new Set([root]); let changed = true;
  while (changed) { changed = false; for (const p of all) if (ids.has(p.ParentProcessId) && !ids.has(p.ProcessId)) { ids.add(p.ProcessId); changed = true; } }
  return all.filter(p => ids.has(p.ProcessId));
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let browserAvailable = true; try { findSystemBrowser(); } catch { browserAvailable = false; }

it.skipIf(process.env.GLINT_NLE_CANCEL_E2E !== "1" || process.platform !== "win32" || !browserAvailable)("cancels a real Windows NLE render and its observed Chromium descendants", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-nle-cancel-"));
  const previous = process.env.GLINT_DATA_DIR; process.env.GLINT_DATA_DIR = root;
  // @ts-expect-error JavaScript server exercised over actual HTTP.
  const { createWebServer } = await import("./index.mjs");
  const server = createWebServer() as Server; let observed: Proc[] = [];
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const controller = new AbortController();
    const request = fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/nle/render`, {
      method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal,
      body: JSON.stringify({ project: { schemaVersion: 1, id: "cancel-real", title: "Cancel", fps: 20, width: 1920, height: 1080, tracks: [{ id: "t", kind: "text", name: "文字", clips: [{ id: "caption", kind: "text", text: "Cancellation", startMs: 0, durationMs: 30000 }] }] } }),
    }).catch(error => error);
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      const all = processes();
      const cli = all.find(p => p.ParentProcessId === process.pid && p.CommandLine?.toLowerCase().includes(root.toLowerCase()));
      if (cli) { observed = descendants(all, cli.ProcessId); if (observed.some(p => /^(chrome|msedge)\.exe$/i.test(p.Name))) break; }
      await sleep(300);
    }
    expect(observed.some(p => /^(chrome|msedge)\.exe$/i.test(p.Name)), "render must reach a real Chromium process").toBe(true);
    controller.abort(); expect((await request).name).toBe("AbortError");
    let survivors = observed;
    const stopBy = Date.now() + 12000;
    while (Date.now() < stopBy) {
      const current = processes(); survivors = observed.filter(w => current.some(p => p.ProcessId === w.ProcessId && p.CreationDate === w.CreationDate));
      if (!survivors.length) break;
      await sleep(300);
    }
    expect(survivors.map(p => `${p.Name}:${p.ProcessId}`)).toEqual([]);
    await sleep(300);
    const exportsDir = path.join(root, "exports"), files = fs.existsSync(exportsDir) ? fs.readdirSync(exportsDir) : [];
    expect(files).toEqual([]);
    console.log("NLE_CANCEL_TREE", JSON.stringify({ observed: observed.map(p => p.Name), survivors: survivors.length }));
  } finally {
    // Never signal enumerated PIDs: a Windows parent PID can be reused and a
    // snapshot alone does not establish ownership of an external process.
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    if (previous === undefined) delete process.env.GLINT_DATA_DIR; else process.env.GLINT_DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  }
}, 60000);
