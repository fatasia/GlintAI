import { useEffect, useState } from "react";
import { Button } from "./ui/Button";
import { executionText as t } from "./media-execution-i18n";
import { MediaExecutionConfig } from "./MediaExecutionConfig";
import { useExecutionConfig, useExecutionTask } from "./use-media-execution";
import {
  executionRequest,
  executionPayload,
  type ExecutionConfig,
  type ExecutionQuote,
} from "./media-execution-client";
import "./MediaExecutionPanel.css";

import type { MediaExecutionProps as Props } from "./media-execution-types";
import { MediaExecutionResult as ExecutionResult } from "./MediaExecutionResult";
export function MediaExecutionPanel(props: Props) {
  const { config, refresh, error, setError } = useExecutionConfig();
  return (
    <section className="tool-block execution-panel" aria-label={t("execution.title")}>
      <header>
        <h3>{t("execution.title")}</h3>
        <p className="tool-note">{t("execution.help")}</p>
      </header>
      {error && (
        <p role="alert" className="tool-alert">
          {error}
        </p>
      )}
      {config && (
        <>
          <MediaExecutionConfig config={config} refresh={refresh} failed={setError} />
          <ExecutionForm key={props.storageKey} config={config} {...props} />
        </>
      )}
    </section>
  );
}
type FormProps = Props & { config: ExecutionConfig };
function ExecutionForm(props: FormProps) {
  return <ExecutionFormView {...useExecutionForm(props)} />;
}
type FormViewProps = ReturnType<typeof useExecutionForm>;
function useExecutionForm(props: FormProps) {
  const [bindingId, setBinding] = useState(
      () =>
        props.config.bindings.find(
          (binding) =>
            binding.ready &&
            binding.entry?.kind === props.initialPayload?.type &&
            binding.entry?.adapter.model === props.initialPayload?.model,
        )?.id ?? "",
    ),
    [prompt, setPrompt] = useState(
      String(props.initialPayload?.prompt ?? props.initialPrompt ?? ""),
    ),
    [params, setParams] = useState(JSON.stringify(props.initialPayload?.params ?? {}));
  const [quote, setQuote] = useState<ExecutionQuote | null>(null),
    [error, setError] = useState("");
  const task = useExecutionTask(props.storageKey);
  const bindings = props.config.bindings.filter(
    (binding) =>
      binding.ready &&
      (!props.onUseVideo || binding.entry?.kind === "video") &&
      (!props.initialType || binding.entry?.kind === props.initialType),
  );
  const bound = bindings.find((binding) => binding.id === bindingId);
  const input = () => ({
    ...props.initialPayload,
    ...executionPayload(bindingId, bound?.entry, prompt, JSON.parse(params)),
  });
  const pending = Boolean(task.requestId && !task.task?.isFinal);
  useEffect(() => {
    props.onBusyChange?.(task.busy || pending);
  }, [task.busy, pending, props.onBusyChange]);
  const getQuote = async () => {
    try {
      const parsed: unknown = JSON.parse(params);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error(t("execution.invalid"));

      setError("");
      setQuote(await executionRequest<ExecutionQuote>("quote", input()));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  const edit = () => {
    setQuote(null);
    setError("");
  };
  return {
    props,
    task,
    bindings,
    bindingId,
    bound,
    pending,
    prompt,
    params,
    quote,
    error,
    input,
    setBinding,
    setPrompt,
    setParams,
    edit,
    getQuote,
  };
}
function ExecutionFormView({
  props,
  task,
  bindings,
  bindingId,
  bound,
  pending,
  prompt,
  params,
  quote,
  error,
  input,
  setBinding,
  setPrompt,
  setParams,
  edit,
  getQuote,
}: FormViewProps) {
  return (
    <div className="execution-form">
      {!bindings.length && <p className="tool-note">{t("execution.empty")}</p>}
      <BindingSelect {...{ bindings, bindingId, pending, setBinding, edit }} />
      {bound?.entry && <p className="tool-meta">{bound.entry.capabilities.join(" · ")}</p>}
      <ExecutionInputs {...{ pending, prompt, params, setPrompt, setParams, edit }} />
      <Button
        disabled={
          props.disabled ||
          task.busy ||
          pending ||
          !bound ||
          (bound.entry?.adapter.type !== "comfyui" && !prompt.trim())
        }
        onClick={() => void getQuote()}
      >
        {t("execution.quote")}
      </Button>
      {quote && !task.requestId && (
        <QuoteConfirmation
          quote={quote}
          disabled={props.disabled || task.busy}
          submit={(cap) => task.submit(input(), quote.id, cap)}
        />
      )}
      {(error || task.error) && (
        <p role="alert" className="tool-alert">
          {error || task.error}
        </p>
      )}
      <ExecutionResult task={task} {...props} />
    </div>
  );
}
function QuoteConfirmation({
  quote,
  disabled,
  submit,
}: {
  quote: ExecutionQuote;
  disabled?: boolean;
  submit(cap: number): Promise<void>;
}) {
  const [confirmed, setConfirmed] = useState(false),
    [cap, setCap] = useState(String(quote.amount));
  return (
    <div className="execution-quote">
      <p className="execution-price">
        {t("execution.price")}{" "}
        <strong>
          {quote.amount.toFixed(4)} {quote.unit}
        </strong>
      </p>
      <p className="tool-note">{t("execution.source")}</p>
      <p className="tool-note">{t("execution.notBill")}</p>
      <label>
        {t("execution.cap")}
        <input
          className="g-field"
          type="number"
          min="0"
          step="0.0001"
          value={cap}
          onChange={(event) => {
            setCap(event.target.value);
            setConfirmed(false);
          }}
        />
      </label>
      <label className="tool-check">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
        />
        {t("execution.confirm")}
      </label>
      <Button
        variant="primary"
        disabled={
          disabled ||
          !confirmed ||
          !cap ||
          !Number.isFinite(Number(cap)) ||
          Number(cap) < quote.amount ||
          quote.expiresAt <= Date.now()
        }
        onClick={() => void submit(Number(cap))}
      >
        {t("execution.approve")}
      </Button>
    </div>
  );
}
function ExecutionInputs({
  pending,
  prompt,
  params,
  setPrompt,
  setParams,
  edit,
}: Pick<FormViewProps, "pending" | "prompt" | "params" | "setPrompt" | "setParams" | "edit">) {
  return (
    <>
      {" "}
      <label>
        {t("execution.prompt")}
        <textarea
          className="g-field"
          rows={3}
          disabled={pending}
          value={prompt}
          onChange={(event) => {
            setPrompt(event.target.value);
            edit();
          }}
        />
      </label>
      <label>
        {t("execution.params")}
        <textarea
          className="g-field"
          rows={2}
          disabled={pending}
          value={params}
          onChange={(event) => {
            setParams(event.target.value);
            edit();
          }}
        />
      </label>
    </>
  );
}

function BindingSelect({
  bindings,
  bindingId,
  pending,
  setBinding,
  edit,
}: Pick<FormViewProps, "bindings" | "bindingId" | "pending" | "setBinding" | "edit">) {
  return (
    <>
      {" "}
      <label>
        {t("execution.bound")}
        <select
          className="g-field"
          disabled={pending}
          value={bindingId}
          onChange={(event) => {
            setBinding(event.target.value);
            edit();
          }}
        >
          <option value="">—</option>
          {bindings.map((binding) => (
            <option key={binding.id} value={binding.id}>
              {binding.entry?.name} · {binding.accountId}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}
