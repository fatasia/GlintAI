import { useEffect, useState, type CSSProperties } from "react";
interface InstallEvent extends Event { prompt(): Promise<void> }
export function OfflineStatus() {
  const [offline, setOffline] = useState(!navigator.onLine);
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const [install, setInstall] = useState<InstallEvent | null>(null);
  useEffect(() => {
    if (!install) return;
    const timer = setTimeout(() => setInstall(null), 12_000);
    return () => clearTimeout(timer);
  }, [install]);
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
  const chip: CSSProperties = { pointerEvents: "auto", display: "inline-flex", alignItems: "center", gap: 6, border: "1px solid #2b2b31", borderRadius: 999, background: "#18181b", color: "#d4d4d8", padding: "8px 12px", fontSize: 12, font: "inherit", cursor: "pointer", boxShadow: "0 10px 30px rgba(0,0,0,.45)" };
  return <div style={{ position: "fixed", left: 16, bottom: 16, zIndex: 50, color: "#a1a1aa", fontSize: 12, display: "flex", gap: 8, flexWrap: "wrap", pointerEvents: "none" }}>
    {offline && <span role="status" style={{ ...chip, cursor: "default", color: "#fcd34d", pointerEvents: "none" }}>当前离线：可查看已缓存示例；生成、提问与下载需要连接本机服务。</span>}
    {install && <button style={chip} onClick={() => { void install.prompt(); setInstall(null); }}>安装 Glint</button>}
    {waiting && <button style={chip} onClick={() => {
      if (!window.confirm("更新会重新加载页面。请先等待当前任务或提问结束。")) return;
      navigator.serviceWorker.addEventListener("controllerchange", () => location.reload(), { once: true }); waiting.postMessage("activate");
    }}>有新版本，重新加载</button>}
  </div>;
}
