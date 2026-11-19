import { useState } from "react";
import { Button } from "./ui/Button";
import { executionText as t } from "./media-execution-i18n";
import { executionRequest } from "./media-execution-client";
import type { useExecutionTask } from "./use-media-execution";

export function MediaExecutionOutputs({ state }: { state: ReturnType<typeof useExecutionTask> }) {
  const [index, setIndex] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  if (!state.task?.outputs?.length) return null;
  const importResult = async () => {
    setBusy(true);
    setError("");
    try {
      await executionRequest(`import/${state.task!.taskId}`, { outputIndex: Number(index) });
      await state.recover(state.requestId, state.task!.taskId);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="execution-form">
      <label>
        {t("execution.outputs")}
        <select
          className="g-field"
          value={index}
          onChange={(event) => setIndex(event.target.value)}
        >
          <option value="">—</option>
          {state.task.outputs.map((output) => (
            <option key={output.index} value={output.index}>
              {output.name}
            </option>
          ))}
        </select>
      </label>
      <Button disabled={busy || index === ""} onClick={() => void importResult()}>
        {t("execution.import")}
      </Button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
