const terminal = state => state === "success" || state === "failed";

function cached(record, id) {
  if (!record.isFinal || !terminal(record.state)) return null;
  const receipt = record.terminalReceipt;
  if (receipt?.is_final === true && receipt.state === record.state && receipt.task_id === id && (receipt.state === "failed" || typeof receipt.result_url === "string" && receipt.result_url)) return receipt;
  // Failed legacy tasks have no downloadable result to recover.
  return record.state === "failed" ? { task_id: id, state: "failed", is_final: true } : null;
}

/** First durable terminal result wins; network replies may complete out of order. */
export async function resolveMediaTaskStatus(id, read, write, poll) {
  let record = read();
  if (record.cancelled) return { record };
  let task = cached(record, id);
  if (!task) {
    try { task = await poll(); }
    catch (error) {
      record = read();
      if (record.cancelled) return { record };
      task = cached(record, id);
      if (!task) throw error;
    }
  }
  record = read();
  if (record.cancelled) return { record };
  const settled = cached(record, id);
  if (settled) return { record, task: settled };
  // Older success records lack the URL receipt. A contradictory poll must not
  // replace them; a later matching success can still supply a missing download.
  if (record.isFinal && terminal(record.state) && task.state !== record.state) {
    return { record, task: { task_id: id, state: record.state, is_final: true, cost: record.cost } };
  }
  if (task.is_final && terminal(task.state)) {
    const cost = Number.isFinite(record.terminalReceipt?.cost) ? record.terminalReceipt.cost : task.cost;
    task = { task_id: id, state: task.state, is_final: true,
      ...(typeof task.result_url === "string" ? { result_url: task.result_url } : {}),
      ...(Number.isFinite(cost) ? { cost } : {}) };
    record = { ...record, state: task.state, isFinal: true, terminalReceipt: task };
    write(record);
  }
  return { record, task };
}

/** A failed signed URL may need fresh metadata, but never a new generation. */
export async function downloadTerminalResult(task, download, read, write) {
  try { return await download(); }
  catch (error) {
    if (/^Source HTTP (401|403|404|410)$/.test(error?.message ?? "")) {
      const record = read();
      if (record.terminalReceipt?.result_url === task.result_url) {
        const { result_url: _expired, ...receipt } = record.terminalReceipt;
        write({ ...record, terminalReceipt: receipt });
      }
    }
    throw error;
  }
}
