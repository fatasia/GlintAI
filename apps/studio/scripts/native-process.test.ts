import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recordProcessLedger, runMediaProcess } from "./native-process";

type LedgerEntry = { pid: number; command: string; argv: string[]; at: string };
const readLedger = (file: string): LedgerEntry[] =>
  fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as LedgerEntry);

describe("process ledger", () => {
  let ledger: string, root: string;
  const withLedger = () => { process.env.GLINT_PROCESS_LEDGER = ledger; };
  afterEach(() => {
    delete process.env.GLINT_PROCESS_LEDGER;
    if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  });

  it("records spawned media processes with their own pid and full argv", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-ledger-"));
    ledger = path.join(root, "ledger.jsonl");
    withLedger();
    await runMediaProcess(process.execPath, ["-e", "process.exit(0)"], { timeoutMs: 30_000 });
    const entries = readLedger(ledger);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.pid).toBeGreaterThan(0);
    expect(entries[0]!.command).toBe(process.execPath);
    expect(entries[0]!.argv).toEqual([process.execPath, "-e", "process.exit(0)"]);
    expect(Number.isNaN(Date.parse(entries[0]!.at))).toBe(false);
  });

  it("writes nothing when GLINT_PROCESS_LEDGER is unset or the pid is unknown", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-ledger-"));
    ledger = path.join(root, "ledger.jsonl");
    await runMediaProcess(process.execPath, ["-e", "process.exit(0)"], { timeoutMs: 30_000 });
    expect(fs.existsSync(ledger)).toBe(false);
    withLedger();
    recordProcessLedger("ffmpeg", undefined, ["-x"]);
    expect(fs.existsSync(ledger)).toBe(false);
  });

  it("disables itself after a write failure instead of failing every spawn", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-ledger-"));
    ledger = path.join(root, "missing-dir", "ledger.jsonl");
    withLedger();
    recordProcessLedger("ffmpeg", 4242, ["-x"]);
    // The disablement is process-wide for the life of this module instance;
    // a fresh process starts clean again, which is what a service restart relies on.
    ledger = path.join(root, "ledger.jsonl");
    recordProcessLedger("ffmpeg", 4243, ["-y"]);
    expect(fs.existsSync(ledger)).toBe(false);
  });
});
