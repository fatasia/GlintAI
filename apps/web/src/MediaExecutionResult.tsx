import { applicationUrl } from "./app-url";
import { Button } from "./ui/Button";
import { executionText as t } from "./media-execution-i18n";
import type { useExecutionTask } from "./use-media-execution";
import { MediaExecutionOutputs } from "./MediaExecutionOutputs";
import type { MediaExecutionProps as Props } from "./media-execution-types";
export function MediaExecutionResult(props: Props & { task: ReturnType<typeof useExecutionTask> }) {
  const { task: state } = props,
    task = state.task;
  if (!state.requestId) return null;
  return (
    <div className="execution-result">
      <p className="tool-meta">
        {state.requestId}
        {task && ` · ${task.taskId} · ${task.state ?? "pending"}`}
      </p>
      <div className="tool-actions">
        <Button
          disabled={state.busy}
          onClick={() => void state.recover(state.requestId, task?.taskId)}
        >
          {t("execution.recover")}
        </Button>
        {task && !task.isFinal && (
          <Button disabled={state.busy} onClick={() => void state.cancel()}>
            {t("execution.cancel")}
          </Button>
        )}
        {task?.isFinal && (
          <Button disabled={state.busy} onClick={state.reset}>
            {t("execution.new")}
          </Button>
        )}
      </div>
      <p className="tool-note">{t("execution.observed")}</p>
      <p className="tool-note">{t("execution.cancelNote")}</p>
      {task?.cancellation && <p role="status">{task.cancellation}</p>}
      <MediaExecutionOutputs state={state} />
      <ExecutionAsset {...props} />
    </div>
  );
}
function ResultPreview({ url }: { url: string }) {
  const src = applicationUrl(url);
  return /\.(png|jpg|webp)$/.test(url) ? (
    <img className="tool-preview" src={src} alt={t("execution.result")} />
  ) : url.endsWith(".mp4") ? (
    <video className="tool-preview" controls src={src} />
  ) : (
    <audio controls src={src} />
  );
}

function ExecutionAsset(props: Props & { task: ReturnType<typeof useExecutionTask> }) {
  const task = props.task.task;
  return (
    <>
      {" "}
      {task?.assetUrl && (
        <>
          <ResultPreview url={task.assetUrl} />
          <div className="tool-actions">
            <a
              className="g-button g-button--secondary g-button--sm"
              href={applicationUrl(task.assetUrl)}
              download
            >
              {t("execution.download")}
            </a>
            {props.onUseMedia && task.isFinal && (
              <Button disabled={props.disabled} onClick={() => void props.onUseMedia!(task)}>
                {props.useMediaLabel ?? t("execution.use")}
              </Button>
            )}
            {props.onUseVideo &&
              task.isFinal &&
              /^\/api\/media\/assets\/[A-Za-z0-9_-]{1,100}\.mp4$/.test(task.assetUrl) && (
                <Button
                  disabled={props.disabled}
                  onClick={() =>
                    void props.onUseVideo!({
                      url: task.assetUrl!,
                      origin: "generated",
                      source: task.taskId,
                    })
                  }
                >
                  {props.useVideoLabel}
                </Button>
              )}
          </div>
        </>
      )}
    </>
  );
}
