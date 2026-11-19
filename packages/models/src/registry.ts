import { ModelEntry, type ModelEntryInput, type ModelKind } from "./schema";

export class RegistryError extends Error {
  constructor(readonly code: "duplicate" | "invalid" | "unknown" | "too-large", message: string) {
    super(message);
    this.name = "RegistryError";
  }
}

const MAX_ENTRIES = 500;

export interface ModelRegistry {
  readonly entries: readonly ModelEntry[];
  get(id: string): ModelEntry;
  find(id: string): ModelEntry | undefined;
  list(filter?: { kind?: ModelKind; capability?: string; requires?: readonly string[] }): ModelEntry[];
  /** Returns a new registry; the original is never mutated. */
  with(entry: ModelEntryInput): ModelRegistry;
  without(id: string): ModelRegistry;
}

function parseEntry(input: unknown): ModelEntry {
  const result = ModelEntry.safeParse(input);
  if (!result.success) {
    const id = typeof (input as { id?: unknown })?.id === "string" ? (input as { id: string }).id : "?";
    throw new RegistryError("invalid", `Model "${id}" is invalid: ${result.error.issues.map(issue => `${issue.path.join(".") || "(root)"} ${issue.message}`).join("; ")}`);
  }
  return result.data;
}

export function createRegistry(inputs: readonly unknown[] = []): ModelRegistry {
  if (inputs.length > MAX_ENTRIES) throw new RegistryError("too-large", `A registry holds at most ${MAX_ENTRIES} models`);
  const entries: ModelEntry[] = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    const entry = parseEntry(input);
    if (seen.has(entry.id)) throw new RegistryError("duplicate", `Duplicate model id "${entry.id}"`);
    seen.add(entry.id);
    entries.push(entry);
  }
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const registry: ModelRegistry = {
    entries,
    find: id => byId.get(id),
    get: id => { const entry = byId.get(id); if (!entry) throw new RegistryError("unknown", `Unknown model "${id}"`); return entry; },
    list: (filter = {}) => entries.filter(entry => {
      if (filter.kind && entry.kind !== filter.kind) return false;
      if (filter.capability && !entry.capabilities.includes(filter.capability)) return false;
      return (filter.requires ?? []).every(capability => entry.capabilities.includes(capability));
    }),
    with: entry => createRegistry([...entries, entry]),
    without: id => { if (!byId.has(id)) throw new RegistryError("unknown", `Unknown model "${id}"`); return createRegistry(entries.filter(entry => entry.id !== id)); },
  };
  return registry;
}

/** Parses a user-supplied registry file; the JSON shape is `{ "models": [...] }`. */
export function parseRegistryJson(text: string): ModelRegistry {
  if (text.length > 512 * 1024) throw new RegistryError("too-large", "Registry file is larger than 512 KiB");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new RegistryError("invalid", "Registry file is not valid JSON"); }
  const models = (value as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) throw new RegistryError("invalid", 'Registry file needs a "models" array');
  return createRegistry(models);
}
