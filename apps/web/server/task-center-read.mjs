import fs from "node:fs";
import path from "node:path";
const ID = /^[a-zA-Z0-9_-]{1,100}$/;
const RENDER_ID = /^idea-[a-z0-9-]+$/;
const STATES = new Set([
  "queued",
  "pending",
  "running",
  "recovering",
  "cancelling",
  "done",
  "success",
  "failed",
  "cancelled",
  "unknown",
  "unconfirmed",
]);
const FINAL = new Set(["done", "success", "failed", "cancelled"]);

function project(record, filename, render) {
  const id = render ? record.id : record.taskId;
  if (typeof id !== "string" || !(render ? RENDER_ID : ID).test(id) || `${id}.json` !== filename)
    return null;
  if (!render && !["skills", "openai-images", "comfyui"].includes(record.protocol)) return null;
  if (!render && record.protocol === "comfyui" && !/^comfy-[a-zA-Z0-9_-]{1,64}$/.test(id))
    return null;
  const family = render ? "render" : record.protocol === "comfyui" ? "comfyui" : "media";
  const rawState = render
    ? record.status
    : record.cancelled
      ? "cancelled"
      : (record.terminal?.state ?? record.state);
  const state = STATES.has(rawState) ? rawState : "unknown";
  const date =
    typeof record.createdAt === "number" || typeof record.createdAt === "string"
      ? new Date(record.createdAt)
      : null;
  const receipt = record.terminalReceipt;
  const cost =
    receipt?.task_id === id && receipt.is_final === true && Number.isFinite(receipt.cost)
      ? receipt.cost
      : record.cost;
  const amount = !render && family === "media" && Number.isFinite(cost) && cost >= 0 ? cost : null;
  return {
    family,
    id,
    state,
    isFinal: FINAL.has(state),
    createdAt: date && Number.isFinite(date.getTime()) ? date.toISOString() : null,
    cost: { amount, unit: null },
  };
}

function directoryReader(directory) {
  const resolved = path.resolve(directory);
  const original = fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
  return (render) => {
    const rows = [];
    let truncated = false,
      unreadable = 0,
      count = 0;
    if (!fs.existsSync(resolved)) return { rows, truncated, unreadable };
    if (fs.lstatSync(resolved).isSymbolicLink() || fs.realpathSync(resolved) !== original)
      throw new Error("Task directory changed");
    const handle = fs.opendirSync(resolved);
    try {
      for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
        if (++count > 500) {
          truncated = true;
          break;
        }
        if (!entry.name.endsWith(".json") || entry.name.startsWith("request-")) continue;
        if (!(render ? /^idea-[a-z0-9-]+\.json$/ : /^[a-zA-Z0-9_-]{1,100}\.json$/).test(entry.name))
          continue;
        const file = path.join(resolved, entry.name);
        let fd;
        try {
          const stat = fs.lstatSync(file);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 256 * 1024) {
            unreadable++;
            continue;
          }
          fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
          const opened = fs.fstatSync(fd);
          if (
            opened.ino !== stat.ino ||
            opened.dev !== stat.dev ||
            opened.size !== stat.size ||
            fs.realpathSync(file) !== path.join(original, entry.name)
          )
            throw new Error("Task record changed");
          const bytes = Buffer.alloc(opened.size + 1),
            size = fs.readSync(fd, bytes, 0, bytes.length, 0);
          if (size !== opened.size) throw new Error("Task record changed");
          const value = JSON.parse(bytes.subarray(0, size).toString("utf8"));
          const row =
            value && typeof value === "object" && !Array.isArray(value)
              ? project(value, entry.name, render)
              : null;
          if (row) rows.push(row);
        } catch {
          unreadable++;
        } finally {
          if (fd !== undefined) fs.closeSync(fd);
        }
      }
    } finally {
      handle.closeSync();
    }
    return { rows, truncated, unreadable };
  };
}

/** Read-only bounded projection; never polls providers or mutates task records. */
export function createTaskCenterReader({ mediaDir, renderStateDir }) {
  const media = directoryReader(mediaDir),
    render = directoryReader(renderStateDir);
  return () => {
    const sources = [media(false), render(true)];
    const rows = sources
      .flatMap((source) => source.rows)
      .sort(
        (a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "") || a.id.localeCompare(b.id),
      );
    return {
      tasks: rows.slice(0, 100),
      truncated: rows.length > 100 || sources.some((source) => source.truncated),
      unreadable: sources.reduce((sum, source) => sum + source.unreadable, 0),
    };
  };
}
