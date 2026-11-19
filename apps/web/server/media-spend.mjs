import fs from "node:fs";
import path from "node:path";
/** Historical unit-less local ledger, not a verified CNY bill. */
export function mediaSpend(root, taskFile, writeAtomic) {
  const spendFile = path.join(root, "spend.json");
  const readSpend = () => {
    try {
      const parsed = JSON.parse(fs.readFileSync(spendFile, "utf8"));
      return Number.isFinite(parsed.total) ? parsed : { total: 0, count: 0 };
    } catch {
      return { total: 0, count: 0 };
    }
  };
  const recordSpend = (taskId, cost) => {
    if (!Number.isFinite(cost) || cost <= 0) return;
    try {
      const record = JSON.parse(fs.readFileSync(taskFile(taskId), "utf8"));
      if (record.costRecorded) return;
      fs.writeFileSync(taskFile(taskId), JSON.stringify({ ...record, costRecorded: true }));
    } catch {
      /* no local record to mark: skip rather than risk double-counting */ return;
    }
    const spend = readSpend();
    writeAtomic(
      spendFile,
      Buffer.from(JSON.stringify({ total: spend.total + cost, count: spend.count + 1 })),
    );
  };
  return { readSpend, recordSpend };
}
