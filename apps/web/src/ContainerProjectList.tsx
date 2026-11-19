import { useEffect, useState } from "react";
import { readContainerList, type ContainerProjectPage } from "./container-workspace-client";
import { Button } from "./ui/Button";
import { t } from "./ui/i18n";

export function ContainerProjectList({ onOpen }: { onOpen(projectId: string, objectId?: string): void }) {
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  const [page, setPage] = useState<ContainerProjectPage | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState(false), [retry, setRetry] = useState(0);
  const cursor = cursors[cursors.length - 1];
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(false); setPage(null);
    void readContainerList(cursor, controller.signal).then(value => {
      if (!controller.signal.aborted) setPage(value);
    }).catch(() => { if (!controller.signal.aborted) setError(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [cursor, retry]);
  return <section className="ws-group" aria-label={t("container.listTitle")}>
    <h2 className="ws-row-title">{t("container.listTitle")}</h2>
    {loading && <p role="status" className="ws-note">{t("container.listLoading")}</p>}
    {error && <><p role="alert" className="ws-note">{t("container.listError")}</p><Button onClick={() => setRetry(value => value + 1)}>{t("container.listRetry")}</Button></>}
    {page && !page.projects.length && <p role="status" className="ws-note">{t("container.listEmpty")}</p>}
    {page && <div className="ws-list">{page.projects.map(project => <article className="ws-row" key={project.projectId}>
      <div className="ws-row-title"><strong>{project.title}</strong></div>
      <p>{t("container.listCounts", { scenes: project.sceneCount, timelines: project.timelineCount, revision: project.revision })}</p>
      <small>{project.projectId}</small>
      <div className="ws-actions"><Button aria-label={t("container.listOpenLabel", { title: project.title })} onClick={() => onOpen(project.projectId, project.firstDocumentId)}>{t("container.listOpen")}</Button></div>
    </article>)}</div>}
    <nav className="ws-actions" aria-label={t("container.listTitle")}>
      {cursors.length > 1 && <Button disabled={loading} onClick={() => setCursors(value => value.slice(0, -1))}>{t("container.listPrevious")}</Button>}
      {page?.nextCursor && <Button disabled={loading} onClick={() => setCursors(value => [...value, page.nextCursor!])}>{t("container.listNext")}</Button>}
    </nav>
  </section>;
}
