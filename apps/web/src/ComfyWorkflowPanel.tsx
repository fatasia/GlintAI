import { useEffect, useRef, useState } from "react";
import { appFetch } from "./app-url";
import { Button } from "./ui/Button";
import { t } from "./ui/i18n";
import "./ComfyWorkflowPanel.css";
import { ComfyConnectionForm } from "./ComfyConnectionForm";

type NodeCheck = { ok: boolean; checked: number; available: string[]; missing: string[] };
class NotSubmittedError extends Error {}

type Kind = "image" | "video" | "audio";
type Journal = { requestId?: string; taskId?: string };
type Job = { taskId: string; type?: Kind; state: string; isFinal: boolean; outputs: { index: number; name: string }[] };
const storageKey = "glint.comfyui-task", requestPattern = /^[a-zA-Z0-9_-]{1,64}$/, taskPattern = /^[a-zA-Z0-9_-]{1,100}$/;
const states = { pending: "comfy.pending", running: "comfy.running", success: "comfy.success", failed: "comfy.failed", unknown: "comfy.unknown", unconfirmed: "comfy.unconfirmed" } as const;
function readJournal(): Journal {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
    return { ...(requestPattern.test(value?.requestId ?? "") ? { requestId: value.requestId } : {}), ...(taskPattern.test(value?.taskId ?? "") ? { taskId: value.taskId } : {}) };
  } catch { return {}; }
}
function saveJournal(value: Journal) {
  try { localStorage.setItem(storageKey, JSON.stringify(value)); }
  catch { throw new Error(t("comfy.storageError")); }
}
async function request(route: string, signal: AbortSignal, body?: unknown) {
  const response = await appFetch(route, { signal, ...(body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  const data = await response.json();
  if (!response.ok) {
    if (data.submitted === false && ((response.status === 422 && data.code === "missing-nodes") || (response.status === 503 && data.code === "node-check-failed"))) throw new NotSubmittedError(t(data.code === "missing-nodes" ? "comfy.nodes.submitMissing" : "comfy.nodes.unavailable"));
    throw new Error(typeof data.error === "string" ? data.error : t("comfy.requestError"));
  }
  return data;
}
function taskIdentity(data: { taskId?: unknown }): string {
  if (typeof data.taskId !== "string" || !taskPattern.test(data.taskId)) throw new Error(t("comfy.responseError"));
  return data.taskId;
}
function parseInputs(text: string) {
  const inputs: unknown = JSON.parse(text);
  if (!Array.isArray(inputs) || inputs.some(item => !item || typeof item.nodeId !== "string" || typeof item.input !== "string" || !["string", "number", "boolean"].includes(typeof item.value) || typeof item.value === "number" && !Number.isFinite(item.value))) throw new Error(t("comfy.inputsError"));
  return inputs;
}
function decodeJob(data: Job, expectedId: string): Job {
  if (taskIdentity(data) !== expectedId || !Object.hasOwn(states, data.state) || typeof data.isFinal !== "boolean" || !Array.isArray(data.outputs) || data.outputs.some(output => !Number.isInteger(output.index) || output.index < 0 || typeof output.name !== "string")) throw new Error(t("comfy.responseError"));
  return data;
}

/** Optional workflow execution uses the existing media journal and library. */
export function ComfyWorkflowPanel({ refreshLibrary }: { refreshLibrary(): Promise<void> | void }) {
  const [configured, setConfigured] = useState<boolean | null>(null), [workflow, setWorkflow] = useState(""), [inputs, setInputs] = useState("[]"), [type, setType] = useState<Kind>("image");
  const [nodeCheck, setNodeCheck] = useState<NodeCheck | null>(null);
  const [endConfirmed, setEndConfirmed] = useState(false);
  const [confirmed, setConfirmed] = useState(false), [journal, setJournal] = useState<Journal>(readJournal), [job, setJob] = useState<Job | null>(null);
  const [connectionBusy, setConnectionBusy] = useState(false);
  const [operationBusy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState(""), [recoveryId, setRecoveryId] = useState(""), [selected, setSelected] = useState("");
  const active = useRef<AbortController | null>(null), mounted = useRef(true), fileVersion = useRef(0);
  const journalRef = useRef(journal), checkVersion = useRef(0);
  const busy = operationBusy || connectionBusy;
  const locked = Boolean(journal.requestId || journal.taskId);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; active.current?.abort(); fileVersion.current++; };
  }, []);
  useEffect(() => { setNodeCheck(null); checkVersion.current++; }, [workflow, inputs]);
  function remember(value: Journal) { saveJournal(value); journalRef.current = value; setJournal(value); }
  async function perform(action: (signal: AbortSignal, current: () => boolean) => Promise<void>) {
    if (active.current) return;
    const controller = new AbortController(); active.current = controller; setBusy(true); setError(""); setNotice("");
    const current = () => mounted.current && active.current === controller && !controller.signal.aborted;
    try { await action(AbortSignal.any([controller.signal, AbortSignal.timeout(40_000)]), current); }
    catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : t("comfy.requestError")); }
    finally { if (current()) { active.current = null; setBusy(false); } }
  }
  async function query(signal: AbortSignal, current: () => boolean, saved: Journal = journal) {
    const taskId = saved.taskId ?? taskIdentity(await request(`/api/media/request/${saved.requestId}`, signal));
    if (!current()) return;
    const next = { ...saved, taskId }; remember(next); setEndConfirmed(false);
    const result = decodeJob(await request(`/api/media/comfyui/status/${taskId}`, signal), taskId);
    if (current()) { setJob(result); setSelected(""); }
  }
  async function submit() {
    await perform(async (signal, current) => {
      const graph: unknown = JSON.parse(workflow);
      if (!graph || typeof graph !== "object" || Array.isArray(graph)) throw new Error(t("comfy.workflowError"));
      const mapped = parseInputs(inputs), next = { requestId: crypto.randomUUID() };
      remember(next); // Persist identity before dispatch; uncertain receipts never unlock resubmission.
      let value;
      try { value = await request("/api/media/comfyui/submit", signal, { ...next, workflow: graph, inputs: mapped, type, confirmed: true }); }
      catch (cause) {
        if (cause instanceof NotSubmittedError && current() && journalRef.current.requestId === next.requestId) { remember({}); setConfirmed(false); setNodeCheck(null); }
        throw cause;
      }
      if (!current()) return;
      await query(signal, current, { ...next, taskId: taskIdentity(value) });
    });
  }
  async function inspectNodes() {
    await perform(async (signal, current) => {
      setNodeCheck(null);
      const graph: unknown = JSON.parse(workflow), version = checkVersion.current;
      if (!graph || typeof graph !== "object" || Array.isArray(graph)) throw new Error(t("comfy.workflowError"));
      const result = await request("/api/media/comfyui/validate", signal, { workflow: graph, inputs: parseInputs(inputs) });
      if (result.submitted !== false || typeof result.ok !== "boolean" || !Number.isSafeInteger(result.checked) || result.checked < 0 || result.checked > 128 || ![result.available, result.missing].every(list => Array.isArray(list) && list.length <= 128 && list.every(name => typeof name === "string" && name.length <= 256))) throw new Error(t("comfy.responseError"));
      if (current() && version === checkVersion.current) setNodeCheck(result);
    });
  }
  async function loadFile(file?: File) {
    if (!file) return;
    setConfirmed(false);
    const version = ++fileVersion.current;
    try {
      if (file.size > 1024 * 1024) throw new Error(t("comfy.fileSize"));
      const text = await file.text();
      if (mounted.current && version === fileVersion.current) { setWorkflow(text); setConfirmed(false); setError(""); }
    } catch (cause) { if (mounted.current && version === fileVersion.current) setError(cause instanceof Error ? cause.message : t("comfy.workflowError")); }
  }
  function clearTracking() {
    try { remember({}); setJob(null); setSelected(""); setRecoveryId(""); setConfirmed(false); setEndConfirmed(false); setNotice(""); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("comfy.storageError")); }
  }
  const canReset = job?.isFinal && (job.state === "success" || job.state === "failed");
  return <section className="tool-block comfy-workflow" aria-label={t("comfy.title")}>
    <div className="tool-block-head"><h3>{t("comfy.title")}</h3><span className="g-label">ComfyUI</span></div>
    <p className="tool-note">{t("comfy.description")}</p>
    <p role="status" className="tool-meta">{configured === null ? t("comfy.checking") : configured ? t("comfy.configured") : t("comfy.notConfigured")}</p>
    <ComfyConnectionForm disabled={locked || operationBusy} onConfigured={value => { setConfigured(value); setConfirmed(false); setNodeCheck(null); checkVersion.current++; }} onBusyChange={value => { setConnectionBusy(value); if (value) { setNodeCheck(null); checkVersion.current++; } }} />
    <fieldset className="comfy-workflow-fields" disabled={busy || locked}>
      <label className="g-form-row"><span>{t("comfy.file")}</span><input type="file" accept="application/json,.json" aria-label={t("comfy.file")} onChange={event => void loadFile(event.target.files?.[0])} /></label>
      <label className="g-form-row"><span>{t("comfy.workflow")}</span><textarea className="g-field" rows={6} aria-label={t("comfy.workflow")} value={workflow} onChange={event => { fileVersion.current++; setWorkflow(event.target.value); setConfirmed(false); }} /></label>
      <details className="tool-details"><summary>{t("comfy.inputs")}</summary><p className="tool-note">{t("comfy.inputsHelp")}</p><textarea className="g-field" rows={3} aria-label={t("comfy.inputs")} value={inputs} onChange={event => { setInputs(event.target.value); setConfirmed(false); }} /></details>
      <label className="g-form-row"><span>{t("comfy.type")}</span><select className="g-field tool-select" aria-label={t("comfy.type")} value={type} onChange={event => { setType(event.target.value as Kind); setConfirmed(false); }}>{(["image", "video", "audio"] as const).map(kind => <option key={kind} value={kind}>{t(`comfy.${kind}`)}</option>)}</select></label>
      <label className="tool-check"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />{t("comfy.confirm")}</label>
    </fieldset>
    {nodeCheck && <div className="tool-band" aria-label={t("comfy.nodes.result")}><p role="status" className="tool-note">{t(nodeCheck.ok ? "comfy.nodes.passed" : "comfy.nodes.missing", { count: nodeCheck.checked })}</p>{nodeCheck.missing.length > 0 && <ul>{nodeCheck.missing.map((name, index) => <li key={index}>{name}</li>)}</ul>}<p className="tool-note">{t("comfy.nodes.scope")}</p></div>}
    <div className="tool-actions">
      <Button disabled={!configured || !workflow.trim() || busy || locked} onClick={() => void inspectNodes()}>{t("comfy.nodes.check")}</Button>
      <Button variant="primary" disabled={!configured || !workflow.trim() || !confirmed || busy || locked} onClick={() => void submit()}>{busy ? t("comfy.busy") : t("comfy.submit")}</Button>
      {locked && <Button disabled={busy} onClick={() => void perform((signal, current) => query(signal, current))}>{t("comfy.query")}</Button>}
      {job && !job.isFinal && <Button disabled={busy} onClick={() => void perform(async (signal, current) => {
        const value = await request(`/api/media/comfyui/cancel/${job.taskId}`, signal, {});
        if (taskIdentity(value) !== job.taskId || !["delete-requested", "not-queued"].includes(value.outcome)) throw new Error(t("comfy.responseError"));
        if (current()) setNotice(value.outcome === "delete-requested" ? t("comfy.cancelRequested") : t("comfy.cancelNotQueued"));
      })}>{t("comfy.cancel")}</Button>}
      {canReset && <Button disabled={busy} onClick={clearTracking}>{t("comfy.new")}</Button>}
    </div>
    {locked && <div className="tool-band"><p className="tool-meta">{t("comfy.receipt")} <code>{journal.requestId ?? "—"}</code></p>{journal.taskId && <p className="tool-meta">{t("comfy.task")} <code>{journal.taskId}</code></p>}<p role="status" className="tool-note">{job ? t(states[job.state as keyof typeof states]) : t("comfy.unconfirmed")}</p><p className="tool-note">{t("comfy.queryHint")}</p></div>}
    {locked && (!job || job.state === "unknown" || job.state === "unconfirmed") && <details className="tool-details">
      <summary>{t("comfy.endTracking")}</summary>
      <div className="tool-band"><p className="tool-note">{t("comfy.endWarning")}</p><label className="tool-check"><input type="checkbox" checked={endConfirmed} disabled={busy} onChange={event => setEndConfirmed(event.target.checked)} />{t("comfy.endConfirm")}</label><Button disabled={busy || !endConfirmed} onClick={clearTracking}>{t("comfy.endAction")}</Button></div>
    </details>}
    {!job && <div className="tool-band"><label className="g-form-row"><span>{t("comfy.recover")}</span><input className="g-field" value={recoveryId} disabled={busy} aria-label={t("comfy.recover")} onChange={event => setRecoveryId(event.target.value)} /></label><Button disabled={busy || !taskPattern.test(recoveryId)} onClick={() => void perform((signal, current) => query(signal, current, { ...journal, taskId: recoveryId }))}>{t("comfy.recoverAction")}</Button></div>}
    {job?.state === "success" && <div className="tool-band"><label className="g-form-row"><span>{t("comfy.output")}</span><select className="g-field tool-select" value={selected} disabled={busy} aria-label={t("comfy.output")} onChange={event => setSelected(event.target.value)}><option value="">{t("comfy.chooseOutput")}</option>{job.outputs.map(output => <option key={output.index} value={output.index}>{output.name}</option>)}</select></label><Button disabled={busy || selected === ""} onClick={() => void perform(async (signal, current) => {
      const result = await request(`/api/media/comfyui/import/${job.taskId}`, signal, { outputIndex: Number(selected) });
      if (typeof result.assetName !== "string" || !/^[a-zA-Z0-9_.-]{1,180}$/.test(result.assetName) || result.assetUrl !== `/api/media/assets/${result.assetName}` || !["image", "video", "audio"].includes(result.type) || !/^[a-f0-9]{64}$/i.test(result.sha256 ?? "")) throw new Error(t("comfy.responseError"));
      if (current()) { setNotice(t("comfy.imported", { name: result.assetName })); await refreshLibrary(); }
    })}>{t("comfy.import")}</Button><p className="tool-note">{t("comfy.importHint")}</p></div>}
    {notice && <p role="status" className="tool-note">{notice}</p>}
    {error && <p role="alert" className="tool-alert">{error}</p>}
  </section>;
}
