import { spawn as nodeSpawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { demand, LIMITS, LocalAgentError, redact } from "./local-agent-common.mjs";

export async function stopOwnedProcess(child, { platform = process.platform, spawnKiller = nodeSpawn } = {}) {
  if (!Number.isSafeInteger(child?.pid) || child.pid <= 0) return true;
  if (platform !== "win32") { try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { return false; } } return true; }
  return new Promise(resolve => {
    let killer, timer, settled = false;
    const finish = success => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (!success) { try { child.kill(); } catch { /* process tree termination remains unconfirmed */ } }
      resolve(success);
    };
    try {
      killer = spawnKiller("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, shell: false, stdio: "ignore" });
      killer.once("error", () => finish(false)); killer.once("close", code => finish(code === 0));
      timer = setTimeout(() => { try { killer.kill(); } catch { /* report uncertainty */ } finish(false); }, 5000);
    } catch { finish(false); }
  });
}
export function safeEnvironment(env = process.env) {
  const allowed = ["PATH", "Path", "PATHEXT", "SYSTEMROOT", "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMDATA", "LANG", "LC_ALL", "TERM",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "KIMI_CONFIG_FILE", "QWEN_CONFIG_DIR"];
  return { ...Object.fromEntries(allowed.filter(key => typeof env[key] === "string").map(key => [key, env[key]])), NO_BROWSER: "1", BROWSER: "none" };
}
export async function openAcpProcess(command, directory, handlers, options = {}) {
  const sdk = await (options.sdkLoader ?? (() => import("@agentclientprotocol/sdk")))();
  const spawn = options.spawn ?? nodeSpawn;
  const cliEnv = Object.fromEntries(Object.entries(command.cliEnv ?? {}).filter(([key]) => ["CODEX_PATH", "CLAUDE_CODE_EXECUTABLE"].includes(key)));
  const child = spawn(command.command, command.args, { cwd: directory, env: { ...safeEnvironment(options.env), ...cliEnv },
    windowsHide: true, shell: false, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
  let connection, stderr = "", stopped = false, stopPromise;
  const stop = () => {
    if (stopPromise) return stopPromise;
    stopped = true; connection?.close();
    stopPromise = stopOwnedProcess(child, options).then(success => { child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy(); return success; });
    return stopPromise;
  };
  child.stderr?.on("data", chunk => { stderr = Buffer.from(stderr + String(chunk)).subarray(-LIMITS.stderrBytes).toString("utf8"); });
  child.on("error", () => { if (!stopped) { handlers.exit("无法启动本地代理，请检查 CLI 路径。"); void stop(); } });
  child.on("exit", () => { if (!stopped) { handlers.exit("本地代理进程已退出，请重新连接。"); void stop(); } });
  demand(child.stdin && child.stdout, "spawn-failed", "本地代理未提供 ACP 标准输入输出。");
  try {
    const app = sdk.client({ name: "glint-local-agent", version: "1" });
    app.onNotification(sdk.methods.client.session.update, ({ params }) => handlers.update(params));
    app.onRequest(sdk.methods.client.session.requestPermission, context => handlers.permission(context.params, context.signal));
    app.onRequest(sdk.methods.client.elicitation.create, context => handlers.elicitation(context.params, context.signal));
    const deny = () => { throw new sdk.RequestError(-32001, "Glint client filesystem/terminal access is disabled"); };
    for (const method of Object.values(sdk.methods.client.fs)) app.onRequest(method, deny);
    for (const method of Object.values(sdk.methods.client.terminal)) app.onRequest(method, deny);
    connection = app.connect(sdk.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout), { maxMessageBytes: LIMITS.eventBytes }));
    connection.closed.then(() => { if (!stopped) { handlers.exit("ACP 连接已关闭，请重新连接。"); void stop(); } }).catch(() => { if (!stopped) void stop(); });
    return {
      sdk, child, stop, get stderr() { return redact(stderr); }, get closed() { return stopped; },
      notify(method, params) { return connection.agent.notify(method, params); },
      async call(method, params, timeoutMs = options.requestTimeoutMs ?? LIMITS.requestMs) {
        demand(!stopped, "disconnected", "代理已断开，请重新连接。");
        let timer;
        const timeout = new Promise((_, reject) => { timer = setTimeout(() => {
          reject(new LocalAgentError("timeout", "本地代理响应超时；进程已取消，请重新连接。")); void stop();
        }, timeoutMs); });
        try { return await Promise.race([connection.agent.request(method, params), timeout]); }
        finally { clearTimeout(timer); }
      },
    };
  } catch (error) { await stop(); throw error; }
}
