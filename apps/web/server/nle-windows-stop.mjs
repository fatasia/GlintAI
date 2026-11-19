import { spawn } from "node:child_process";

// A failed or timed-out taskkill cannot prove that render descendants exited.
export function stopWindowsRenderTree(child, spawnKiller = spawn) {
  if (!child.pid) return Promise.resolve(true);
  return new Promise(resolve => {
    let settled = false, timer;
    const finish = success => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (!success && child.exitCode === null) { try { child.kill(); } catch { /* retain output when termination is uncertain */ } }
      resolve(success);
    };
    let killer;
    try {
      killer = spawnKiller("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, shell: false, stdio: "ignore" });
      killer.once("error", () => finish(false));
      killer.once("close", code => finish(code === 0));
      timer = setTimeout(() => { try { killer.kill(); } catch { /* termination remains unconfirmed */ } finish(false); }, 15000);
    } catch { finish(false); }
  });
}

export async function cleanupStoppedRender(directory, treeStop, remove) {
  const safe = await treeStop;
  if (safe) remove(directory);
  return safe;
}
