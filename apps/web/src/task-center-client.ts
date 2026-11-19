import { appFetch } from "./app-url";
export const taskStates = [
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
] as const;
export type TaskState = (typeof taskStates)[number];
export type TaskFamily = "render" | "media" | "comfyui";
export interface CenterTask {
  family: TaskFamily;
  id: string;
  state: TaskState;
  isFinal: boolean;
  createdAt: string | null;
  cost: { amount: number | null; unit: string | null };
  result?: string;
}
export interface TaskPage {
  tasks: CenterTask[];
  truncated: boolean;
  unreadable: number;
}
const idPattern = /^[a-zA-Z0-9_-]{1,100}$/;
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid task response");
  return value as Record<string, unknown>;
};
function parseTask(value: unknown): CenterTask {
  const task = object(value),
    cost = object(task.cost);
  if (
    !["render", "media", "comfyui"].includes(String(task.family)) ||
    typeof task.id !== "string" ||
    !idPattern.test(task.id) ||
    (task.family === "render" && !/^idea-[a-z0-9-]+$/.test(task.id)) ||
    (task.family === "comfyui" && !/^comfy-[a-zA-Z0-9_-]{1,64}$/.test(task.id)) ||
    !taskStates.includes(task.state as TaskState) ||
    typeof task.isFinal !== "boolean" ||
    !(
      task.createdAt === null ||
      (typeof task.createdAt === "string" && Number.isFinite(Date.parse(task.createdAt)))
    ) ||
    !(
      cost.amount === null ||
      (typeof cost.amount === "number" && Number.isFinite(cost.amount) && cost.amount >= 0)
    ) ||
    !(
      cost.unit === null ||
      (typeof cost.unit === "string" && /^[a-zA-Z0-9_-]{1,24}$/.test(cost.unit))
    )
  )
    throw new Error("Invalid task metadata");
  return {
    family: task.family as TaskFamily,
    id: task.id,
    state: task.state as TaskState,
    isFinal: task.isFinal,
    createdAt: task.createdAt as string | null,
    cost: { amount: cost.amount as number | null, unit: cost.unit as string | null },
  };
}
export function parseTaskPage(value: unknown): TaskPage {
  const data = object(value);
  if (
    !Array.isArray(data.tasks) ||
    data.tasks.length > 100 ||
    typeof data.truncated !== "boolean" ||
    !Number.isInteger(data.unreadable) ||
    Number(data.unreadable) < 0 ||
    Number(data.unreadable) > 1000
  )
    throw new Error("Invalid task list");
  const tasks = data.tasks.map(parseTask);
  if (new Set(tasks.map((task) => `${task.family}:${task.id}`)).size !== tasks.length)
    throw new Error("Duplicate task");
  return { tasks, truncated: data.truncated, unreadable: Number(data.unreadable) };
}
async function request(url: string, signal: AbortSignal, method = "GET") {
  const response = await appFetch(url, {
    method,
    signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    ...(method === "POST" ? { headers: { "content-type": "application/json" }, body: "{}" } : {}),
  });
  if (!response.ok || !response.body) throw new Error("Task request failed");
  const reader = response.body.getReader();
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 1024 * 1024) {
        await reader.cancel();
        throw new Error("Task response exceeds limit");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  signal.throwIfAborted();
  return object(JSON.parse(new TextDecoder().decode(joined)));
}
export type TaskRequest = (
  url: string,
  signal: AbortSignal,
  method?: string,
) => Promise<Record<string, unknown>>;
export async function readTasks(
  signal: AbortSignal,
  transport: TaskRequest = request,
): Promise<TaskPage> {
  return parseTaskPage(await transport("/api/tasks", signal));
}
export function canCancel(task: CenterTask): boolean {
  return (
    !task.isFinal &&
    (task.family !== "render" || ["queued", "running", "recovering"].includes(task.state))
  );
}
function statusPath(task: CenterTask) {
  return task.family === "render"
    ? `/api/make/${task.id}`
    : task.family === "comfyui"
      ? `/api/media/comfyui/status/${task.id}`
      : `/api/media/status/${task.id}`;
}
export async function recoverTask(
  task: CenterTask,
  signal: AbortSignal,
  transport: TaskRequest = request,
): Promise<CenterTask> {
  const data = await transport(statusPath(task), signal),
    state = task.family === "render" ? data.status : data.state;
  if (
    (task.family === "render" ? data.id : data.taskId) !== task.id ||
    !taskStates.includes(state as TaskState)
  )
    throw new Error("Task identity or status mismatch");
  const next = parseTask({
    ...task,
    state,
    isFinal:
      task.family === "render"
        ? ["done", "failed", "cancelled"].includes(String(state))
        : data.isFinal,
    cost: {
      amount: typeof data.cost === "number" ? data.cost : task.cost.amount,
      unit: task.cost.unit,
    },
  });
  if (task.family === "render" && state === "done") next.result = `/api/video/${task.id}`;
  else if (
    typeof data.assetUrl === "string" &&
    /^\/api\/media\/assets\/[a-zA-Z0-9_-]{1,100}\.(png|jpg|webp|mp4|mp3|wav)$/.test(data.assetUrl)
  )
    next.result = data.assetUrl;
  return next;
}
export async function cancelTask(
  task: CenterTask,
  signal: AbortSignal,
  transport: TaskRequest = request,
): Promise<"cancelRequested" | "deleteRequested" | "notQueued"> {
  if (!canCancel(task)) throw new Error("Task is not cancellable");
  if (task.family === "render") {
    const data = await transport(`/api/make/${task.id}`, signal, "DELETE");
    if (data.cancelled !== true) throw new Error("Cancellation is unconfirmed");
    return "cancelRequested";
  }
  const route =
    task.family === "comfyui"
      ? `/api/media/comfyui/cancel/${task.id}`
      : `/api/media/cancel/${task.id}`;
  const data = await transport(route, signal, "POST");
  if (data.taskId !== task.id) throw new Error("Cancellation identity mismatch");
  if (task.family === "comfyui") {
    if (data.outcome === "delete-requested") return "deleteRequested";
    if (data.outcome === "not-queued") return "notQueued";
    throw new Error("Cancellation is unconfirmed");
  }
  if (data.state !== "cancelled" || data.isFinal !== true)
    throw new Error("Cancellation is unconfirmed");
  return "cancelRequested";
}
