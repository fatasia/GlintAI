import { useCallback, useEffect, useState } from "react";
import {
  executionRequest,
  readExecution,
  rememberExecution,
  type ExecutionConfig,
  type ExecutionTask,
} from "./media-execution-client";

export function useExecutionConfig() {
  const [config, setConfig] = useState<ExecutionConfig | null>(null),
    [error, setError] = useState("");
  const refresh = useCallback(async () => {
    const value = await executionRequest<ExecutionConfig>("config");
    if (
      !Array.isArray(value.accounts) ||
      !Array.isArray(value.bindings) ||
      !Array.isArray(value.models?.models) ||
      !Array.isArray(value.models?.builtins)
    )
      throw new Error("execution-config-unavailable");
    setConfig(value);
  }, []);
  useEffect(() => {
    void refresh().catch((failure: Error) => setError(failure.message));
  }, [refresh]);
  return { config, refresh, error, setError };
}
export function useExecutionTask(storageKey: string) {
  const [requestId, setRequest] = useState(""),
    [task, setTask] = useState<ExecutionTask | null>(null);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const recover = useCallback(
    async (id: string, taskId?: string) => {
      setRequest(id);
      setBusy(true);
      setError("");
      try {
        const known = taskId ? { taskId } : await executionRequest<ExecutionTask>(`request/${id}`);
        const current = await executionRequest<ExecutionTask>(`status/${known.taskId}`);
        setTask(current);
        rememberExecution(storageKey, { requestId: id, taskId: current.taskId });
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
      } finally {
        setBusy(false);
      }
    },
    [storageKey],
  );
  useEffect(() => {
    const saved = readExecution(storageKey);
    if (saved) void recover(saved.requestId, saved.taskId);
  }, [storageKey, recover]);
  const { submit, cancel } = useTaskActions({
    storageKey,
    setRequest,
    setTask,
    setBusy,
    setError,
    recover,
    task,
  });
  const reset = () => {
    setRequest("");
    setTask(null);
    setError("");
    try {
      localStorage.removeItem(`${storageKey}.bound`);
    } catch {
      /* Optional storage. */
    }
  };
  return { task, requestId, busy, error, submit, recover, cancel, reset };
}

type TaskActions = {
  storageKey: string;
  setRequest: (id: string) => void;
  setTask: (task: ExecutionTask | null) => void;
  setBusy: (value: boolean) => void;
  setError: (message: string) => void;
  recover(id: string, taskId?: string): Promise<void>;
  task: ExecutionTask | null;
};
function useTaskActions({
  storageKey,
  setRequest,
  setTask,
  setBusy,
  setError,
  recover,
  task,
}: TaskActions) {
  const submit = async (input: unknown, quoteId: string, capCny: number) => {
    const id = crypto.randomUUID();
    setRequest(id);
    setBusy(true);
    setError("");
    let approved = false;
    try {
      await executionRequest("approve", { quoteId, requestId: id, capCny, confirmed: true });
      approved = true;
      rememberExecution(storageKey, { requestId: id });
      const current = await executionRequest<ExecutionTask>("submit", {
        ...(input as object),
        quoteId,
        requestId: id,
      });
      setTask(current);
      rememberExecution(storageKey, { requestId: id, taskId: current.taskId });
      await recover(id, current.taskId);
    } catch (failure) {
      if (!approved) setRequest("");
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    if (!task) return;
    setBusy(true);
    try {
      setTask(await executionRequest<ExecutionTask>(`cancel/${task.taskId}`, {}));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  return { submit, cancel };
}
