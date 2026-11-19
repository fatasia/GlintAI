import type { EditTransaction } from "./index";

export interface TransitionContext {
  action: "import" | "edit" | "amend" | "undo" | "redo";
  transaction?: EditTransaction;
}
/** In-process constructor capability only; never accepted in transaction JSON. */
export type DocumentTransition<T extends object = Record<string, unknown>> =
  (before: T | undefined, candidate: T, context: TransitionContext) => T;

export function transitionDocument<T extends object>(policy: DocumentTransition<T> | undefined, before: T | undefined, candidate: T, context: TransitionContext): T {
  if (!policy) return candidate;
  // A throwing/misbehaving callback cannot mutate the live session or request history.
  return structuredClone(policy(before === undefined ? undefined : structuredClone(before), structuredClone(candidate), structuredClone(context)));
}
