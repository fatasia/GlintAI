(() => {
  if (window.top !== window || location.origin !== __GLINT_ORIGIN__) return;
  const channel = window.chrome?.webview;
  if (!channel) return;
  const documentId = crypto.randomUUID();
  const pending = new Map();
  let nextId = 0;
  window.addEventListener("glint-native-result", event => {
    const message = event.detail;
    if (message?.type !== "glint-agent-result" || message.documentId !== documentId) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(message.error));
    else entry.resolve(message.result);
  });
  const request = payload => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("桌面连接超时，请重新打开智能体面板。"));
    }, 90000);
    pending.set(id, { resolve, reject, timer });
    channel.postMessage(JSON.stringify({ type: "glint-agent", documentId, id, request: payload }));
  });
  window.addEventListener("pagehide", () => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("页面已离开。"));
    }
    pending.clear();
  });
  Object.defineProperty(window, "glintDesktop", { value: Object.freeze({ request }), configurable: false, writable: false });
})();
