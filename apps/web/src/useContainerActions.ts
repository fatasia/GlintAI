import { useRef, useState, useEffect } from "react";
import { appFetch } from "./app-url";
import { readContainerReply, type ContainerSnapshot } from "./container-workspace-client";
import { assertAllAuthoringCanLeave, useAuthoringLeaveGuard } from "./authoring-leave";
import { t } from "./ui/i18n";

type Pending = { action: string; body: unknown; objectId?: string };
type Options = { onCommitted(): void; onOpen(projectId: string, objectId?: string): void };
export function useContainerActions(options: Options) {
  const request = useRef<Pending | null>(null),
    running = useRef(false),
    live = useRef(true);
  const [busy, setBusy] = useState(false),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  usePendingGuard(request);
  const execute = async (entry: Pending) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      const response = await postAction(entry);
      if (!response.ok) {
        request.current = null;
        setPending(false);
        options.onCommitted();
      }
      const snapshot = await readContainerReply(response);
      request.current = null;
      setPending(false);
      options.onCommitted();
      if (entry.objectId) options.onOpen(snapshot.container.id, entry.objectId);
      else if (["open", "migrate-copy"].includes(entry.action))
        options.onOpen(snapshot.container.id);
      return snapshot;
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      running.current = false;
      if (live.current) setBusy(false);
    }
  };
  const submit = (
    action: string,
    body: unknown,
    objectId?: string,
  ): Promise<ContainerSnapshot | undefined> | undefined => {
    if (request.current) return;
    try {
      assertAllAuthoringCanLeave();
    } catch (cause) {
      setError((cause as Error).message);
      return;
    }
    request.current = { action, body, objectId };
    setPending(true);
    return execute(request.current);
  };
  return { busy, pending, error, submit, retry: () => request.current && execute(request.current) };
}

function postAction(entry: Pending) {
  return appFetch(`/api/project-containers/${entry.action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(entry.body),
  });
}

function usePendingGuard(request: import("react").RefObject<Pending | null>) {
  useAuthoringLeaveGuard("container-operation", () => {
    if (request.current) throw new Error(t("containerV2.pending"));
  });
}
