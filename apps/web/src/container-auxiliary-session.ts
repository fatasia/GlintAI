import { useEffect, useRef, useState } from "react";
import { parseAuxiliaryDocument } from "@glintai/scenescript/project-container-v2";
import {
  createContainerDocumentTransport,
  type ContainerDocumentBinding,
} from "./container-document-transport";
import { StudioSessionClient, type SessionView, type SessionDocument } from "./session-client";
import { useAuthoringLeaveGuard } from "./authoring-leave";
import { t } from "./ui/i18n";

export type AuxiliaryDocument = ReturnType<typeof parseAuxiliaryDocument>;
export function useContainerDocumentSession<T extends SessionDocument>(
  binding: ContainerDocumentBinding & { onCommitted(): void },
  parse: (input: unknown) => T,
  initial: T,
  active: boolean,
) {
  const client = useRef<StudioSessionClient<T> | null>(null),
    committed = useRef(-1);
  const [view, setView] = useState<SessionView<T> | null>(null);
  useEffect(() => {
    const session = new StudioSessionClient(
      initial,
      (next) => {
        setView(next);
        if (
          next.status === "ready" &&
          !next.dirty &&
          next.look &&
          committed.current !== next.look.revision
        ) {
          committed.current = next.look.revision;
          binding.onCommitted();
        }
      },
      undefined,
      createContainerDocumentTransport(binding, parse),
    );
    client.current = session;
    void session.connect();
    return () => {
      session.dispose();
      client.current = null;
    };
  }, [binding.projectId, binding.objectId]);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void client.current?.poll(), 2500);
    return () => clearInterval(timer);
  }, [active]);
  const settled = !!view && !view.dirty && view.status === "ready";
  useAuthoringLeaveGuard(binding.projectId, () => {
    if (!settled) throw new Error(t("container.blocked"));
  });
  return { client, view, settled };
}

export function auxiliaryEditorState(projectId: string, document: AuxiliaryDocument) {
  return { version: 1 as const, projectId, documents: [document], activeId: document.id };
}
/** In-memory editor buffer only. It never reads or writes standalone localStorage documents. */
export function createAuthoringBuffer(initial: unknown) {
  let raw = JSON.stringify(initial);
  return {
    getItem: () => raw,
    setItem: (_key: string, value: string) => {
      raw = value;
    },
    replace: (value: unknown) => {
      raw = JSON.stringify(value);
    },
  };
}
