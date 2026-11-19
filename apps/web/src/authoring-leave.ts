import { useEffect, useRef } from "react";
import { pendingDesignDrafts, pendingScriptDrafts } from "./authoring-drafts";

const guards = new Map<string, Set<() => void>>();

/** Read-only checks, including retained editors. Never save, accept or deactivate here. */
export function registerAuthoringLeaveGuard(projectId: string, check: () => void): () => void {
  const entries = guards.get(projectId) ?? new Set<() => void>();
  entries.add(check); guards.set(projectId, entries);
  return () => {
    entries.delete(check);
    if (!entries.size && guards.get(projectId) === entries) guards.delete(projectId);
  };
}

export function assertAuthoringCanLeave(projectIds: string[]): void {
  for (const id of new Set(projectIds)) {
    if (pendingScriptDrafts.has(id) || pendingDesignDrafts.has(id))
      throw new Error("当前或目标工程仍有未保存的脚本或设计草稿；请先保存或导出，未载入本机版本，也未清除草稿。");
    for (const check of guards.get(id) ?? []) check();
  }
}
export function assertAllAuthoringCanLeave(): void {
  assertAuthoringCanLeave([...guards.keys(), ...pendingScriptDrafts.keys(), ...pendingDesignDrafts.keys()]);
}

export function useAuthoringLeaveGuard(projectId: string | undefined, check: () => void): void {
  const current = useRef(check); current.current = check;
  useEffect(() => {
    if (projectId === undefined) return;
    const verify = () => current.current();
    const release = registerAuthoringLeaveGuard(projectId, verify);
    const unload = (event: BeforeUnloadEvent) => {
      try { verify(); }
      catch { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", unload);
    return () => { release(); window.removeEventListener("beforeunload", unload); };
  }, [projectId]);
}
