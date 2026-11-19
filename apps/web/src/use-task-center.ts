import { useEffect, useRef, useState } from "react";
import { t } from "./ui/i18n";
import {
  cancelTask,
  readTasks,
  recoverTask,
  type CenterTask,
  type TaskPage,
} from "./task-center-client";
export const taskKey = (task: CenterTask) => `${task.family}:${task.id}`;
function useTaskState() {
  const [page, setPage] = useState<TaskPage | null>(null),
    [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState<string | null>("list"),
    [error, setError] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null),
    [notice, setNotice] = useState<string>("");
  const operation = useRef<AbortController | null>(null);
  return {
    page,
    setPage,
    revision,
    setRevision,
    busy,
    setBusy,
    error,
    setError,
    confirm,
    setConfirm,
    notice,
    setNotice,
    operation,
  };
}
type TaskState = ReturnType<typeof useTaskState>;
function useTaskHistory({
  revision,
  operation,
  setBusy,
  setError,
  setConfirm,
  setNotice,
  setPage,
}: TaskState) {
  useEffect(() => {
    const controller = new AbortController();
    operation.current = controller;
    setBusy("list");
    setError(false);
    setConfirm(null);
    setNotice("");
    void readTasks(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setPage(result);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(null);
      });
    return () => {
      controller.abort();
      operation.current?.abort();
    };
  }, [revision]);
}
function useTaskAction({
  busy,
  operation,
  setBusy,
  setError,
  setNotice,
  setConfirm,
  setPage,
}: TaskState) {
  async function perform(task: CenterTask, cancel: boolean) {
    if (busy) return;
    const controller = new AbortController();
    operation.current?.abort();
    operation.current = controller;
    setBusy(taskKey(task));
    setError(false);
    setNotice("");
    setConfirm(null);
    try {
      if (cancel) {
        const outcome = await cancelTask(task, controller.signal);
        if (!controller.signal.aborted) setNotice(t(`tasks.${outcome}`));
      } else {
        const updated = await recoverTask(task, controller.signal);
        if (!controller.signal.aborted) {
          setPage(
            (current) =>
              current && {
                ...current,
                tasks: current.tasks.map((row) => (taskKey(row) === taskKey(task) ? updated : row)),
              },
          );
          setNotice(t("tasks.updated"));
        }
      }
    } catch {
      if (!controller.signal.aborted) {
        setError(true);
        setNotice(t("tasks.actionError"));
      }
    } finally {
      if (!controller.signal.aborted) setBusy(null);
    }
  }
  return perform;
}
export function useTaskCenter() {
  const state = useTaskState();
  useTaskHistory(state);
  const perform = useTaskAction(state);
  const refresh = () => state.setRevision((value) => value + 1);
  return { ...state, perform, refresh };
}
export type TaskCenterModel = ReturnType<typeof useTaskCenter>;
