import { useEffect, useState } from "react";
interface InstallEvent extends Event { prompt(): Promise<void> }
export function OfflineStatus() {
  const [offline, setOffline] = useState(!navigator.onLine);
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const [install, setInstall] = useState<InstallEvent | null>(null);
  useEffect(() => {
    const online = () => setOffline(false), offline = () => setOffline(true);
    const prompt = (event: Event) => { event.preventDefault(); setInstall(event as InstallEvent); };
    window.addEventListener("online", online); window.addEventListener("offline", offline); window.addEventListener("beforeinstallprompt", prompt);
    let live = true;
    if ("serviceWorker" in navigator && import.meta.env.PROD) {
      void navigator.serviceWorker.register("/sw.js").then((registration) => {
        if (!live) return;
        setWaiting(registration.waiting);
        registration.addEventListener("updatefound", () => registration.installing?.addEventListener("statechange", () => {
          if (live && registration.waiting && navigator.serviceWorker.controller) setWaiting(registration.waiting);
        }));
      }).catch(() => {});
    }
    return () => { live = false; window.removeEventListener("online", online); window.removeEventListener("offline", offline); window.removeEventListener("beforeinstallprompt", prompt); };
  }, []);
  return <div style={{ color: "#a7b4c4", fontSize: 13, display: "flex", gap: 12, flexWrap: "wrap" }}>
    {offline && <span role="status">当前离线：可查看已缓存示例，生成、提问与下载需要连接本机服务。</span>}
    {install && <button onClick={() => { void install.prompt(); setInstall(null); }}>安装 Glint</button>}
    {waiting && <button onClick={() => {
      if (!window.confirm("更新会重新加载页面。请先等待当前任务或提问结束。")) return;
      navigator.serviceWorker.addEventListener("controllerchange", () => location.reload(), { once: true }); waiting.postMessage("activate");
    }}>有新版本，重新加载</button>}
  </div>;
}
