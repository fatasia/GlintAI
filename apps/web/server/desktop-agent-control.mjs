import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

export function createDesktopAgentControl({ dataDir, mediaDir, createHost } = {}) {
  let host;
  let gitHost;
  let archiveHost;
  let closing = false;
  const loadGit = () => gitHost ??= import("./project-git-host.mjs").then(module => module.createProjectGitHost({ dataDir }));
  const loadArchive = () => archiveHost ??= (async () => {
    if (process.platform !== "win32" || !mediaDir || !path.isAbsolute(mediaDir)) throw new Error("完整工程包需要 Windows 桌面客户端。");
    const bundled = fileURLToPath(new URL("./glint-secure-assets.exe", import.meta.url));
    const development = fileURLToPath(new URL("../../desktop/secure-assets/target/release/glint-secure-assets.exe", import.meta.url));
    const executable = fs.existsSync(bundled) ? bundled : development;
    const [{ createProjectArchiveHost }, { openSecureAssets }] = await Promise.all([import("./project-archive-host.mjs"), import("./secure-assets-bridge.mjs")]);
    return createProjectArchiveHost({ openStore: () => openSecureAssets(executable, mediaDir) });
  })();
  const load = () => host ??= (async () => {
    const factory = createHost ?? (await import("./local-agent-host.mjs")).createLocalAgentHost;
    return factory({ dataDir });
  })();
  return {
    async request(request) {
      if (closing) throw new Error("桌面工作台正在关闭。");
      const service = request?.action === "archive" ? await loadArchive() : request?.action === "git" ? await loadGit() : await load();
      if (closing) throw new Error("桌面工作台正在关闭。");
      if (request?.action === "archive") {
        try { return await service.request(request); }
        catch (error) { return {ok:false,error:error.message ?? "工程包操作失败，请重试。"}; }
      }
      return service.request(request);
    },
    async dispose() {
      closing = true;
      if (host) await (await host).dispose();
      if (gitHost) await (await gitHost).dispose();
      if (archiveHost) await (await archiveHost).dispose();
    },
  };
}
