import type { EditTransaction } from "@glintai/session";
import { canonicalProjectJson, type ProjectVersion } from "@glintai/scenescript/project-container";
import {
  isContainerDocument,
  type ProjectContainerV2,
} from "@glintai/scenescript/project-container-v2";

type Guard = (before: unknown | undefined, after: unknown) => void;
type TransitionContext = {
  action: "import" | "edit" | "amend" | "undo" | "redo";
  transaction?: EditTransaction;
};
const equal = (a: unknown, b: unknown) => canonicalProjectJson(a) === canonicalProjectJson(b);
const frozen = (payload: unknown) => (payload as { frozen?: boolean })?.frozen === true;

function retainHistory(
  previous: ProjectContainerV2,
  candidate: ProjectContainerV2,
  history: boolean,
) {
  const retained = new Map(previous.versions.map((version) => [version.id, version]));
  const seen = new Set<string>();
  for (const version of candidate.versions) {
    if (
      seen.has(version.id) ||
      (retained.has(version.id) && !equal(retained.get(version.id), version))
    )
      throw new Error("Immutable version was reused or changed");
    if (history && !retained.has(version.id)) throw new Error("History cannot invent a version");
    seen.add(version.id);
  }
  if (
    !history &&
    previous.versions.some(
      (version, i) => !candidate.versions[i] || !equal(version, candidate.versions[i]),
    )
  )
    throw new Error("Cannot delete or reorder immutable versions");
  if (history) {
    candidate.versions = previous.versions;
    const incoming = new Map(candidate.objects.map((item) => [item.id, item]));
    if (candidate.objects.some((item) => !previous.objects.some((prior) => item.id === prior.id)))
      throw new Error("History cannot invent an object");
    candidate.objects = previous.objects.map(
      (item) => incoming.get(item.id) ?? { ...item, archived: true },
    );
  }
  return retained;
}
function guardObject(
  previous: ProjectContainerV2,
  next: ProjectContainerV2,
  object: ProjectContainerV2["objects"][number],
  retained: Map<string, ProjectVersion>,
  context: TransitionContext,
  guard: Guard,
) {
  const prior = previous.objects.find((item) => item.id === object.id);
  const added = next.versions.filter(
    (item) => item.objectId === object.id && !retained.has(item.id),
  );
  const payload = next.versions.find((item) => item.id === object.currentVersionId)!.payload;
  if (!prior) {
    if (
      !isContainerDocument(object.kind) ||
      object.archived ||
      added.length !== 1 ||
      added[0]!.parentVersionId ||
      added[0]!.id !== object.currentVersionId ||
      frozen(payload)
    )
      throw new Error("New objects require one active, unfrozen document version");
    guard(undefined, payload);
  } else {
    if (prior.kind !== object.kind) throw new Error("Object kind is immutable");
    if (!isContainerDocument(object.kind)) {
      if (!equal(prior, object) || added.length)
        throw new Error("Only document objects may change");
      return;
    }
    const old = retained.get(prior.currentVersionId)!.payload;
    if (frozen(old) && object.archived !== prior.archived)
      throw new Error("Frozen documents cannot be archived or restored");
    if (prior.archived && (object.currentVersionId !== prior.currentVersionId || added.length))
      throw new Error("Restore an archived document before editing it");
    if (added.length > 1 || (added.length && object.currentVersionId !== added[0]!.id))
      throw new Error("Commit a document version and its pointer together");
    guard(old, payload);
    for (const version of added)
      if (version.parentVersionId !== prior.currentVersionId)
        throw new Error("New version requires the current parent");
  }
  for (const version of added) {
    if (
      context.action !== "edit" ||
      version.actor !== context.transaction?.actor ||
      version.transactionId !== context.transaction?.id
    )
      throw new Error("New version must bind the committing transaction");
    guard(prior ? retained.get(prior.currentVersionId)!.payload : undefined, version.payload);
  }
}
/** Existing transaction engine remains authoritative, including lifecycle undo/redo. */
export function transitionContainerV2(
  previous: ProjectContainerV2,
  candidate: ProjectContainerV2,
  context: TransitionContext,
  parse: (value: unknown) => ProjectContainerV2,
  guard: Guard,
) {
  if (
    candidate.version !== 2 ||
    candidate.id !== previous.id ||
    !equal(candidate.migration ?? null, previous.migration ?? null)
  )
    throw new Error("Container format and migration identity are immutable");
  const history = context.action === "undo" || context.action === "redo";
  const retained = retainHistory(previous, candidate, history),
    next = parse(candidate);
  if (previous.objects.some((item, i) => next.objects[i]?.id !== item.id))
    throw new Error("Cannot remove, reorder or reuse object identities");
  for (const object of next.objects) guardObject(previous, next, object, retained, context, guard);
  return next;
}
