import { useEffect, useRef, useState } from "react";
import type { ModelEntry } from "@glintai/models";
import { parseRegistryImport, REGISTRY_BYTES, type RegistrySnapshot } from "./model-registry-data";
import { registryRequest } from "./model-registry-client";
const code = (cause: unknown) =>
  cause && typeof cause === "object" && "code" in cause ? String(cause.code) : "storage";
function useRegistryConnection() {
  const [view, setView] = useState({
    snapshot: null as RegistrySnapshot | null,
    busy: false,
    error: "",
    saved: false,
  });
  const pending = useRef<AbortController | null>(null);
  const run = async (body?: unknown) => {
    if (pending.current) return false;
    const controller = new AbortController();
    pending.current = controller;
    setView((current) => ({ ...current, busy: true, error: "", saved: false }));
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const snapshot = await registryRequest(controller.signal, body);
      if (pending.current !== controller || controller.signal.aborted) return false;
      setView({ snapshot, busy: false, error: "", saved: body !== undefined });
      return true;
    } catch (cause) {
      if (pending.current === controller)
        setView((current) => ({ ...current, error: code(cause), busy: false }));
      return false;
    } finally {
      clearTimeout(timeout);
      if (pending.current === controller) pending.current = null;
    }
  };
  useEffect(() => {
    void run();
    return () => {
      pending.current?.abort();
      pending.current = null;
    };
  }, []);
  return { ...view, run };
}
function useRegistryDraft() {
  const [draft, setDraft] = useState({
    text: "",
    preview: null as ModelEntry[] | null,
    confirmed: false,
    error: "",
  });
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const change = (text: string) => {
    generation.current++;
    setDraft({ text, preview: null, confirmed: false, error: "" });
  };
  const inspect = () => {
    try {
      const preview = parseRegistryImport(draft.text);
      setDraft((current) => ({ ...current, preview, confirmed: false, error: "" }));
    } catch (cause) {
      setDraft((current) => ({ ...current, preview: null, confirmed: false, error: code(cause) }));
    }
  };
  const file = async (value?: File) => {
    if (!value) return;
    const expected = ++generation.current;
    if (value.size > REGISTRY_BYTES) {
      setDraft((current) => ({ ...current, error: "too-large" }));
      return;
    }
    try {
      const text = await value.text();
      if (generation.current === expected) change(text);
    } catch {
      if (generation.current === expected)
        setDraft((current) => ({ ...current, error: "invalid" }));
    }
  };
  return {
    ...draft,
    change,
    inspect,
    file,
    setConfirmed: (confirmed: boolean) => setDraft((current) => ({ ...current, confirmed })),
  };
}
export function useModelRegistry() {
  const connection = useRegistryConnection(),
    draft = useRegistryDraft();
  const reload = async () => {
    if (await connection.run()) draft.setConfirmed(false);
  };
  const save = async () => {
    if (!draft.preview || !draft.confirmed || !connection.snapshot) return;
    if (
      await connection.run({
        registry: { models: draft.preview },
        baseDigest: connection.snapshot.digest,
      })
    )
      draft.setConfirmed(false);
  };
  const saved =
    connection.saved &&
    draft.preview !== null &&
    JSON.stringify(draft.preview) === JSON.stringify(connection.snapshot?.models);
  return { ...connection, ...draft, saved, error: draft.error || connection.error, reload, save };
}
