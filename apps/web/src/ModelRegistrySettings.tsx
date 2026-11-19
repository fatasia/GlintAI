import type { ModelEntry } from "@glintai/models";
import { useModelRegistry } from "./use-model-registry";
import { registryTemplate } from "./model-registry-data";
import { downloadRegistry } from "./model-registry-client";
import { Button } from "./ui/Button";
import { t } from "./ui/i18n";
import "./ModelRegistrySettings.css";

type State = ReturnType<typeof useModelRegistry>;
function price(model: ModelEntry): string {
  const value = model.pricing;
  if (value.basis === "unknown") return t("registry.unknown");
  if (value.basis === "free-local") return t("registry.local");
  return t("registry.price", { amount: value.amountCny, basis: t(`registry.${value.basis}`) });
}
function RegistryList({ models, builtin = false }: { models: ModelEntry[]; builtin?: boolean }) {
  return (
    <ul className="registry-list">
      {models.map((model) => (
        <li key={model.id}>
          <div>
            <strong>{model.name}</strong>
            <small>
              {model.id} · {model.provider} · {model.kind}
            </small>
          </div>
          <div>
            <span>{model.capabilities.join(" · ") || t("registry.noCapabilities")}</span>
            <small>{price(model)}</small>
          </div>
          <span className="registry-state">
            {t(builtin ? "registry.builtin" : "registry.registered")}
          </span>
        </li>
      ))}
    </ul>
  );
}
function RegistryFeedback({ state }: { state: State }) {
  const codes = {
    invalid: "registry.invalid",
    "too-large": "registry.too-large",
    secret: "registry.secret",
    reserved: "registry.reserved",
    conflict: "registry.conflict",
    busy: "registry.busyError",
  } as const;
  const message =
    state.error in codes ? codes[state.error as keyof typeof codes] : "registry.storage";
  return (
    <>
      {state.busy && <p role="status">{t("registry.busy")}</p>}
      {state.error && (
        <p role="alert" className="registry-error">
          {t(message)}
        </p>
      )}
      {state.saved && <p role="status">{t("registry.saved")}</p>}
    </>
  );
}
function RegistryImport({ state }: { state: State }) {
  return (
    <div className="registry-import">
      <label className="g-form-row">
        <span>{t("registry.file")}</span>
        <input
          type="file"
          accept=".json,application/json"
          disabled={state.busy}
          onChange={(event) => {
            void state.file(event.currentTarget.files?.[0]);
            event.currentTarget.value = "";
          }}
        />
      </label>
      <label className="g-form-row">
        <span>{t("registry.input")}</span>
        <textarea
          className="g-field registry-json"
          value={state.text}
          onChange={(event) => state.change(event.target.value)}
          disabled={state.busy}
          spellCheck={false}
        />
      </label>
      <p className="g-sub">{t("registry.limit")}</p>
      <div className="registry-actions">
        <Button disabled={state.busy || !state.text.trim()} onClick={state.inspect}>
          {t("registry.preview")}
        </Button>
      </div>
      {state.preview && (
        <>
          <h3>{t("registry.previewCount", { count: state.preview.length })}</h3>
          <RegistryList models={state.preview} />
          <label className="registry-confirm">
            <input
              type="checkbox"
              checked={state.confirmed}
              onChange={(event) => state.setConfirmed(event.target.checked)}
              disabled={state.busy}
            />
            <span>{t("registry.confirm")}</span>
          </label>
          <Button
            variant="primary"
            disabled={state.busy || !state.confirmed || !state.snapshot || Boolean(state.error)}
            onClick={() => void state.save()}
          >
            {t("registry.save")}
          </Button>
        </>
      )}
    </div>
  );
}
export function ModelRegistrySettings() {
  const state = useModelRegistry();
  return (
    <section className="registry-settings" aria-label={t("registry.title")}>
      <header>
        <h3>{t("registry.title")}</h3>
        <p className="g-sub">{t("registry.help")}</p>
      </header>
      <div className="registry-actions">
        <Button disabled={state.busy} onClick={() => void state.reload()}>
          {t("registry.reload")}
        </Button>
        <Button
          disabled={!state.snapshot || state.busy}
          onClick={() => state.snapshot && downloadRegistry(state.snapshot.models)}
        >
          {t("registry.export")}
        </Button>
      </div>
      <Button
        size="sm"
        variant="ghost"
        disabled={state.busy}
        onClick={() => downloadRegistry(registryTemplate())}
      >
        {t("registry.template")}
      </Button>
      <RegistryFeedback state={state} />
      {state.snapshot && (
        <>
          <h3>{t("registry.current", { count: state.snapshot.models.length })}</h3>
          {state.snapshot.models.length ? (
            <RegistryList models={state.snapshot.models} />
          ) : (
            <p className="g-sub">{t("registry.empty")}</p>
          )}
          <details>
            <summary>{t("registry.builtins", { count: state.snapshot.builtins.length })}</summary>
            <RegistryList models={state.snapshot.builtins} builtin />
          </details>
        </>
      )}
      <RegistryImport state={state} />
    </section>
  );
}
