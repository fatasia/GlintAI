import path from "node:path";
import { executionStore, requireExecution, safeId } from "./media-execution-store.mjs";

export function cloudRecords(root) {
  const record = (name) =>
    executionStore(path.join(root, name), {}, (value) => {
      requireExecution(value && typeof value === "object", "invalid-media-record", 409);
      return value;
    });
  return {
    request(id) {
      requireExecution(safeId(id), "invalid-request");
      return record(`request-${id}.json`);
    },
    task(id) {
      requireExecution(
        typeof id === "string" && id.startsWith("cloud-") && safeId(id.slice(6)),
        "invalid-task",
      );
      return record(`${id}.json`);
    },
    async read(id) {
      const value = await this.task(id).read();
      const result = value.taskId ? value : await this.request(id.slice(6)).read();
      requireExecution(
        result.taskId === id && ["fal", "replicate"].includes(result.protocol),
        "unknown-task",
        404,
      );
      return result;
    },
    async save(id, value) {
      await this.task(id).update((state) => {
        const cancelled = state.state === "cancelled",
          cancellation = state.cancellation;
        Object.assign(state, value);
        if (cancelled) state.state = "cancelled";
        if (cancellation) state.cancellation = cancellation;
      });
    },
  };
}
