import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { expect, it } from "vitest";
import { findSystemBrowser } from "../../studio/scripts/direct-browser/host";

// DELIVER-02 编码阶段取消重测：4K 透明 VP9 进入 FFmpeg 编码后取消。
// 归属只来自受控进程台账（我们自己的 spawn 记录），观测只读（查询 PID 的
// 进程名，绝不向枚举结果发送任何信号——2026-10-27 事故后的硬边界）。
type LedgerEntry = { pid: number; command: string; argv: string[]; at: string };

function readLedger(file: string): LedgerEntry[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as LedgerEntry);
}

/** 只读：返回该 PID 当前进程名；不存在或已换名（PID 复用）则返回空。 */
function processName(pid: number): string {
  const json = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue) -join ','`], { encoding: "utf8", windowsHide: true });
  // Some Windows hosts append a diagnostic line after PowerShell exits.
  return json.split(/\r?\n/, 1)[0]!.trim();
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let browserAvailable = true; try { findSystemBrowser(); } catch { browserAvailable = false; }

it.skipIf(process.env.GLINT_NLE_ENCODE_CANCEL_E2E !== "1" || process.platform !== "win32" || !browserAvailable)("cancels a real 4K alpha VP9 encode and verifies the ledgered ffmpeg exited", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-nle-encode-cancel-"));
  const ledgerFile = path.join(root, "process-ledger.jsonl");
  const previousDataDir = process.env.GLINT_DATA_DIR;
  const previousLedger = process.env.GLINT_PROCESS_LEDGER;
  process.env.GLINT_DATA_DIR = root;
  process.env.GLINT_PROCESS_LEDGER = ledgerFile;
  // @ts-expect-error JavaScript server exercised over actual HTTP.
  const { createWebServer } = await import("./index.mjs");
  const server = createWebServer() as Server;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const controller = new AbortController();
    const request = fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/nle/render`, {
      method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal,
      body: JSON.stringify({
        alpha: true,
        project: { schemaVersion: 1, id: "encode-cancel", title: "Encode cancel", fps: 20, width: 3840, height: 2160, tracks: [{ id: "t", kind: "text", name: "文字", clips: [{ id: "caption", kind: "text", text: "编码阶段取消", startMs: 0, durationMs: 3500 }] }] },
      }),
    }).then(response => response.json() as Promise<{ error?: string }>).catch(error => ({ error: String(error) }));
    // 采帧先于编码：等台账出现 VP9 视频 FFmpeg（无音频项目，这是唯一的 ffmpeg）。
    const deadline = Date.now() + 180_000;
    let encoder: LedgerEntry | undefined;
    while (Date.now() < deadline) {
      encoder = readLedger(ledgerFile).find(entry => entry.command === "ffmpeg" && entry.argv.includes("-framerate") && entry.argv.includes("libvpx-vp9"));
      if (encoder) break;
      await sleep(500);
    }
    expect(encoder, "render must reach the VP9 encode stage (process ledger)").toBeTruthy();
    const nameAtCancel = processName(encoder!.pid);
    expect(nameAtCancel.toLowerCase()).toContain("ffmpeg");
    controller.abort();
    // 客户端断开后服务端消息不会送达：fetch 只会抛 AbortError。taskkill 分支
    // 改由文件系统推断——cleanupStoppedRender 仅在 treeStop 确认成功时清目录。
    const clientOutcome = await request as { error?: string };
    // 只读核查：台账记录的编码 FFmpeg 已退出（消失，或 PID 已被其他名字复用）。
    let ffmpegExited = false, lastSeen = "";
    const stopBy = Date.now() + 20_000;
    while (Date.now() < stopBy) {
      lastSeen = processName(encoder!.pid);
      if (!lastSeen.toLowerCase().includes("ffmpeg")) { ffmpegExited = true; break; }
      await sleep(1000);
    }
    const exportsDir = path.join(root, "exports");
    const directoryCleared = !fs.existsSync(exportsDir) || fs.readdirSync(exportsDir).length === 0;
    const retained = !directoryCleared;
    console.log("NLE_ENCODE_CANCEL", JSON.stringify({
      ffmpegExited, directoryCleared, retained,
      encoderPid: encoder!.pid, nameAtCancel, lastSeen, clientOutcome: clientOutcome.error?.slice(0, 200),
    }));
    expect(ffmpegExited, `ledgered ffmpeg still alive as "${lastSeen}"`).toBe(true);
    expect(/^AbortError/.test(clientOutcome.error ?? ""), "client must observe its own abort").toBe(true);
  } finally {
    // 从不向任何枚举到的 PID 发信号：归属只能来自台账（本进程 spawn 记录）。
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    if (previousDataDir === undefined) delete process.env.GLINT_DATA_DIR; else process.env.GLINT_DATA_DIR = previousDataDir;
    if (previousLedger === undefined) delete process.env.GLINT_PROCESS_LEDGER; else process.env.GLINT_PROCESS_LEDGER = previousLedger;
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  }
}, 420000);
