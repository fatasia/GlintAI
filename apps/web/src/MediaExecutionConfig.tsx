import { useState } from "react";
import { Button } from "./ui/Button";
import { executionText as t } from "./media-execution-i18n";
import { executionRequest, type ExecutionConfig } from "./media-execution-client";

type Props = { config: ExecutionConfig; refresh(): Promise<void>; failed(message: string): void };
export function MediaExecutionConfig(props: Props) {
  return (
    <details className="tool-details">
      <summary>{t("execution.config")}</summary>
      <div className="execution-config">
        <AccountForm {...props} />
        <BindingForm {...props} />
      </div>
    </details>
  );
}
function AccountForm({ refresh, failed }: Props) {
  const [id, setId] = useState(""),
    [provider, setProvider] = useState("fal"),
    [token, setToken] = useState(""),
    [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await executionRequest("accounts", { id, provider, token });
      setToken("");
      await refresh();
    } catch (error) {
      failed(String(error instanceof Error ? error.message : error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="execution-form">
      <label>
        {t("execution.account")}
        <input className="g-field" value={id} onChange={(event) => setId(event.target.value)} />
      </label>
      <label>
        {t("execution.provider")}
        <select
          className="g-field"
          value={provider}
          onChange={(event) => setProvider(event.target.value)}
        >
          <option value="fal">fal</option>
          <option value="replicate">Replicate</option>
        </select>
      </label>
      <label>
        {t("execution.token")}
        <input
          className="g-field"
          type="password"
          autoComplete="off"
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />
      </label>
      <Button disabled={busy || !id || !token} onClick={() => void save()}>
        {t("execution.saveAccount")}
      </Button>
    </div>
  );
}
function useBindingForm({ config, refresh, failed }: Props) {
  const [id, setId] = useState(""),
    [modelId, setModel] = useState(""),
    [accountId, setAccount] = useState(""),
    [busy, setBusy] = useState(false);
  const models = [...config.models.models, ...config.models.builtins].filter((model) =>
    ["image", "video", "audio"].includes(model.kind),
  );
  const selected = models.find((model) => model.id === modelId);
  const accounts = config.accounts.filter(
    (account) => account.configured && account.provider === selected?.adapter.type,
  );
  const save = async () => {
    setBusy(true);
    try {
      await executionRequest("bindings", { id, modelId, accountId });
      await refresh();
    } catch (error) {
      failed(String(error instanceof Error ? error.message : error));
    } finally {
      setBusy(false);
    }
  };
  return { id, modelId, accountId, busy, models, accounts, save, setId, setModel, setAccount };
}
function BindingForm(props: Props) {
  const { id, modelId, accountId, busy, models, accounts, save, setId, setModel, setAccount } =
    useBindingForm(props);
  return (
    <div className="execution-form">
      <label>
        {t("execution.binding")}
        <input className="g-field" value={id} onChange={(event) => setId(event.target.value)} />
      </label>
      <label>
        {t("execution.model")}
        <select
          className="g-field"
          value={modelId}
          onChange={(event) => {
            setModel(event.target.value);
            setAccount("");
          }}
        >
          <option value="">—</option>
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name} · {model.adapter.type} · {model.pricing.basis}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t("execution.account")}
        <select
          className="g-field"
          value={accountId}
          onChange={(event) => setAccount(event.target.value)}
        >
          <option value="">—</option>
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.id}
            </option>
          ))}
        </select>
      </label>
      <Button disabled={busy || !id || !modelId || !accountId} onClick={() => void save()}>
        {t("execution.saveBinding")}
      </Button>
    </div>
  );
}
