import { applicationUrl } from "./app-url";
import { Button } from "./ui/Button";
import { t } from "./ui/i18n";
import { canCancel, type CenterTask } from "./task-center-client";
import { taskKey, type TaskCenterModel } from "./use-task-center";
type Props = { task: CenterTask; model: TaskCenterModel };
function TaskIdentity({ task }: { task: CenterTask }) {
  return (
    <>
      <div className="task-center-identity">
        <div className="task-center-row-heading">
          <h2>{t(`tasks.${task.family}`)}</h2>
          <span className="task-center-state">{t(`tasks.${task.state}`)}</span>
        </div>
        <code>{task.id}</code>
        <small>
          {task.createdAt ? new Date(task.createdAt).toLocaleString() : t("tasks.createdUnknown")}
        </small>
      </div>
      <dl className="task-center-cost">
        <dt>{t("tasks.cost")}</dt>
        <dd>
          {task.cost.amount === null
            ? t("tasks.costUnknown")
            : `${task.cost.amount} · ${task.cost.unit ?? t("tasks.unitUnknown")}`}
        </dd>
      </dl>
    </>
  );
}
function TaskActions({ task, model }: Props) {
  const { busy, perform, setConfirm } = model;
  return (
    <div className="task-center-actions">
      <Button disabled={Boolean(busy)} onClick={() => void perform(task, false)}>
        {busy === taskKey(task) ? t("tasks.busy") : t("tasks.recover")}
      </Button>
      {canCancel(task) && (
        <Button variant="ghost" disabled={Boolean(busy)} onClick={() => setConfirm(taskKey(task))}>
          {t("tasks.cancel")}
        </Button>
      )}
      {task.result && (
        <a className="g-link" href={applicationUrl(task.result)} target="_blank" rel="noreferrer">
          {t("tasks.open")}
        </a>
      )}
      {task.family === "comfyui" && task.isFinal && (
        <a className="g-link" href="#/library/create">
          {t("tasks.library")}
        </a>
      )}
    </div>
  );
}
function TaskCancelConfirm({ task, model }: Props) {
  const { busy, perform, setConfirm } = model;
  return (
    <div className="task-center-confirm">
      <p>
        {t(
          task.family === "render"
            ? "tasks.cancelRender"
            : task.family === "comfyui"
              ? "tasks.cancelComfy"
              : "tasks.cancelMedia",
        )}
      </p>
      <Button onClick={() => void perform(task, true)} disabled={Boolean(busy)}>
        {t("tasks.confirmCancel")}
      </Button>
      <Button variant="ghost" onClick={() => setConfirm(null)}>
        {t("tasks.back")}
      </Button>
    </div>
  );
}
export function TaskCenterRow({ task, model }: Props) {
  return (
    <article className="task-center-row" aria-label={`${t(`tasks.${task.family}`)} ${task.id}`}>
      <TaskIdentity task={task} />
      <TaskActions task={task} model={model} />
      {model.confirm === taskKey(task) && <TaskCancelConfirm task={task} model={model} />}
    </article>
  );
}
