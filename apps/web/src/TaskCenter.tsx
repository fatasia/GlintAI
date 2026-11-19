import { Button } from "./ui/Button";
import { t } from "./ui/i18n";
import { TaskCenterRow } from "./TaskCenterRow";
import { useTaskCenter, taskKey, type TaskCenterModel } from "./use-task-center";
import "./TaskCenter.css";
function TaskNotices({ model }: { model: TaskCenterModel }) {
  const { busy, error, notice, page } = model;
  return (
    <>
      {busy === "list" && <p role="status">{t("tasks.loading")}</p>}
      {error && <p role="alert">{notice || t("tasks.error")}</p>}
      {!error && notice && (
        <p role="status" className="task-center-notice">
          {notice}
        </p>
      )}
      {page?.truncated && <p className="task-center-notice">{t("tasks.truncated")}</p>}
      {Boolean(page?.unreadable) && <p className="task-center-notice">{t("tasks.unreadable")}</p>}
      {page && !page.tasks.length && (
        <div className="task-center-empty">
          <h2>{t("tasks.empty")}</h2>
          <p>{t("tasks.emptyHint")}</p>
          <a className="g-link" href="#/library">
            {t("tasks.library")}
          </a>
        </div>
      )}
    </>
  );
}
export function TaskCenter() {
  const model = useTaskCenter();
  const { busy, page, refresh } = model;
  return (
    <section className="task-center" aria-label={t("tasks.title")}>
      <header className="task-center-heading">
        <div>
          <h1>{t("tasks.title")}</h1>
          <p>{t("tasks.intro")}</p>
        </div>
        <Button onClick={refresh} disabled={Boolean(busy)}>
          {t("tasks.refresh")}
        </Button>
      </header>
      <TaskNotices model={model} />
      <div className="task-center-list">
        {page?.tasks.map((task) => (
          <TaskCenterRow key={taskKey(task)} task={task} model={model} />
        ))}
      </div>
      {Boolean(page?.tasks.length) && <p className="task-center-footnote">{t("tasks.costNote")}</p>}
    </section>
  );
}
