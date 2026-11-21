import { taskRequest, serviceEnvironment, TASK_ACTIONS, type TaskAction } from "./task-api-client";
import { ServiceRequestError } from "./service-http";

export async function runTasks(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  write: (line: string) => void = console.log,
): Promise<number> {
  try {
    const action = args[0] as TaskAction;
    if (!TASK_ACTIONS.includes(action))
      throw new ServiceRequestError("invalid-action");
    const input: Record<string, unknown> = {};
    for (const arg of args.slice(1)) {
      const match = /^--(family|id)=(.+)$/.exec(arg);
      const key = arg === "--confirm" ? "confirm" : match?.[1];
      if (!key || key in input) throw new ServiceRequestError("invalid-argument");
      input[key] = key === "confirm" ? true : match![2];
    }
    write(JSON.stringify(await taskRequest(action, input, serviceEnvironment(env))));
    return 0;
  } catch (error) {
    const known =
      error instanceof ServiceRequestError ? error : new ServiceRequestError("task-request-failed");
    write(
      JSON.stringify({
        error: known.code,
        ...(known.status === undefined ? {} : { status: known.status }),
      }),
    );
    return 2;
  }
}
