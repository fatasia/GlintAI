import {
  readTasks,
  recoverTask,
  cancelTask,
  type TaskFamily,
  type TaskRequest,
} from "../../web/src/task-center-client";
import {
  serviceJson,
  serviceTarget,
  ServiceRequestError,
  type ServiceOptions,
} from "./service-http";

export function serviceEnvironment(env: NodeJS.ProcessEnv): ServiceOptions {
  const endpoint = env.GLINT_CONTAINER_ENDPOINT;
  if (!endpoint) throw new ServiceRequestError("endpoint-required");
  return { endpoint, token: env.GLINT_ACCESS_TOKEN };
}
function taskTransport(options: ServiceOptions): TaskRequest {
  return async (route, signal, method = "GET") => {
    const response = await serviceJson(
      serviceTarget(options.endpoint, route),
      { ...options, signal },
      { method, ...(method === "POST" ? { body: "{}" } : {}) },
      1024 * 1024,
    );
    if (!response.ok) throw new ServiceRequestError("http-refused", response.status);
    const value = response.value;
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new ServiceRequestError("invalid-response");
    return value as Record<string, unknown>;
  };
}
export async function taskRequest(
  action: "list" | "status" | "cancel",
  args: { family?: unknown; id?: unknown; confirm?: unknown },
  options: ServiceOptions,
) {
  if (!["list", "status", "cancel"].includes(action))
    throw new ServiceRequestError("invalid-action");
  if (
    Object.keys(args).some(
      (key) =>
        !(
          action === "list"
            ? []
            : action === "cancel"
              ? ["family", "id", "confirm"]
              : ["family", "id"]
        ).includes(key),
    )
  )
    throw new ServiceRequestError("invalid-argument");
  if (action === "cancel" && args.confirm !== true)
    throw new ServiceRequestError("confirmation-required");
  if (
    action !== "list" &&
    (!["render", "media", "comfyui"].includes(String(args.family)) ||
      typeof args.id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(args.id))
  )
    throw new ServiceRequestError("invalid-task-identity");
  const signal = options.signal ?? new AbortController().signal,
    transport = taskTransport(options);
  try {
    const page = await readTasks(signal, transport);
    if (action === "list") return page;
    const task = page.tasks.find(
      (item) => item.family === (args.family as TaskFamily) && item.id === args.id,
    );
    if (!task) throw new ServiceRequestError("task-not-listed-use-original-entry");
    if (action === "status") return await recoverTask(task, signal, transport);
    return { family: task.family, id: task.id, outcome: await cancelTask(task, signal, transport) };
  } catch (error) {
    if (error instanceof ServiceRequestError) throw error;
    throw new ServiceRequestError("invalid-task-response");
  }
}
