import { useEffect, useRef, useState } from "react";
import { appFetch } from "./app-url";
import { Button } from "./ui/Button";
import { t } from "./ui/i18n";

type Config = { configured: boolean; endpoint?: string | null; source?: "saved" | "environment" | "none" };
type Props = { disabled?: boolean; onConfigured(value: boolean): void; onBusyChange?(value: boolean): void };
const origins = { saved: "comfy.connection.saved", environment: "comfy.connection.default", none: "comfy.connection.none" } as const;
function validOrigin(value: string) {
  if (!/^https?:\/\/(?:127\.0\.0\.1|\[::1\])(?::[0-9]+)?\/?$/.test(value)) return false;
  try { return Boolean(new URL(value).port || new URL(value).hostname); } catch { return false; }
}

/** One configuration read also initializes the workflow panel; no health probe or secrets. */
export function ComfyConnectionForm({ disabled = false, onConfigured, onBusyChange }: Props) {
  const [endpoint, setEndpoint] = useState(""), [source, setSource] = useState<keyof typeof origins>("none");
  const [busy, setBusy] = useState(true), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const active = useRef<AbortController | null>(null), callbacks = useRef({ onConfigured, onBusyChange });
  callbacks.current = { onConfigured, onBusyChange };
  async function exchange(value?: string | null) {
    if (active.current || value !== undefined && disabled) return;
    const controller = new AbortController(); active.current = controller;
    setBusy(true); setError(""); setNotice(""); callbacks.current.onBusyChange?.(true);
    try {
      const response = await appFetch("/api/media/comfyui/config", { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]), ...(value === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: value }) }) });
      const data: Config = await response.json();
      if (!response.ok || typeof data.configured !== "boolean") throw new Error(t("comfy.connection.error"));
      if (controller.signal.aborted || active.current !== controller) return;
      setEndpoint(typeof data.endpoint === "string" ? data.endpoint : ""); setSource(data.source && Object.hasOwn(origins, data.source) ? data.source : "none");
      callbacks.current.onConfigured(data.configured);
      if (value !== undefined) setNotice(t("comfy.connection.updated"));
    } catch {
      if (!controller.signal.aborted && active.current === controller) { setError(t("comfy.connection.error")); callbacks.current.onConfigured(false); }
    } finally {
      if (!controller.signal.aborted && active.current === controller) { active.current = null; setBusy(false); callbacks.current.onBusyChange?.(false); }
    }
  }
  useEffect(() => { void exchange(); return () => { active.current?.abort(); active.current = null; }; }, []);
  return <details className="tool-details">
    <summary>{t("comfy.connection.title")}</summary>
    <div className="tool-band">
      <p className="tool-note">{t("comfy.connection.help")}</p>
      <p className="tool-note">{t(origins[source])}</p>
      {disabled && <p className="tool-note">{t("comfy.connection.locked")}</p>}
      <label className="g-form-row"><span>{t("comfy.connection.endpoint")}</span><input className="g-field" aria-label={t("comfy.connection.endpoint")} type="url" spellCheck={false} autoComplete="off" placeholder="http://127.0.0.1:8188" value={endpoint} disabled={disabled || busy} onChange={event => { setEndpoint(event.target.value); setNotice(""); }} /></label>
      <div className="tool-actions">
        <Button disabled={disabled || busy || !validOrigin(endpoint.trim())} onClick={() => void exchange(endpoint.trim())}>{t("comfy.connection.save")}</Button>
        <Button disabled={disabled || busy} onClick={() => void exchange(null)}>{t("comfy.connection.reset")}</Button>
        <Button disabled={disabled || busy} onClick={() => void exchange()}>{t("comfy.connection.reload")}</Button>
      </div>
      {notice && <p role="status" className="tool-note">{notice}</p>}
      {error && <p role="alert" className="tool-alert">{error}</p>}
    </div>
  </details>;
}
