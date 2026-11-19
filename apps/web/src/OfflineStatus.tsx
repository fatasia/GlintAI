import { useEffect, useState } from "react";
import { applicationUrl } from "./app-url";
import { Button } from "./ui/Button";
import { t } from "./ui/i18n";
import "./OfflineStatus.css";
interface InstallEvent extends Event { prompt(): Promise<void> }
export function OfflineStatus() {
  const [offline, setOffline] = useState(!navigator.onLine);
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const [install, setInstall] = useState<InstallEvent | null>(null);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    if (!install) return;
    const timer = setTimeout(() => setInstall(null), 12_000);
    return () => clearTimeout(timer);
  }, [install]);
  // A reload can offer a deferred update again.
  useEffect(() => {
    if (!waiting || dismissed) return;
    const timer = setTimeout(() => setDismissed(true), 15_000);
    return () => clearTimeout(timer);
  }, [waiting, dismissed]);
  useEffect(() => {
    const online = () => setOffline(false), offline = () => setOffline(true);
    const prompt = (event: Event) => { event.preventDefault(); setInstall(event as InstallEvent); };
    window.addEventListener("online", online); window.addEventListener("offline", offline); window.addEventListener("beforeinstallprompt", prompt);
    let live = true;
    if ("serviceWorker" in navigator && import.meta.env.PROD) {
      void navigator.serviceWorker.register(applicationUrl("/sw.js")).then((registration) => {
        if (!live) return;
        setWaiting(registration.waiting);
        registration.addEventListener("updatefound", () => registration.installing?.addEventListener("statechange", () => {
          if (live && registration.waiting && navigator.serviceWorker.controller) setWaiting(registration.waiting);
        }));
      }).catch(() => {});
    }
    return () => { live = false; window.removeEventListener("online", online); window.removeEventListener("offline", offline); window.removeEventListener("beforeinstallprompt", prompt); };
  }, []);
  if (!offline && !install && (!waiting || dismissed)) return null;
  return <aside className="offline-status" aria-label={t("offline.region")} aria-live="polite">
    {offline && <p role="status" className="offline-status-message">{t("offline.message")}</p>}
    {install && <div className="offline-status-actions"><Button size="sm" onClick={() => { void install.prompt(); setInstall(null); }}>{t("offline.install")}</Button><Button size="sm" variant="ghost" onClick={() => setInstall(null)}>{t("offline.dismissInstall")}</Button></div>}
    {waiting && !dismissed && <div className="offline-status-actions">
      <span>{t("offline.update")}</span>
      <Button size="sm" onClick={() => {
        if (!window.confirm(t("offline.confirmUpdate"))) return;
        navigator.serviceWorker.addEventListener("controllerchange", () => location.reload(), { once: true }); waiting.postMessage("activate");
      }}>{t("offline.reload")}</Button>
      <Button size="sm" variant="ghost" onClick={() => setDismissed(true)}>{t("offline.later")}</Button>
    </div>}
  </aside>;
}
