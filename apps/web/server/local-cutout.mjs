import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./local-cutout.py", import.meta.url));
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Explicit local paths only; no automatic download or model search. */
export function createLocalCutout({ python = process.env.GLINT_CUTOUT_PYTHON, model = process.env.GLINT_CUTOUT_MODEL, spawnImpl = spawn } = {}) {
  const configured = () => { try { return [python, model].every(file => typeof file === "string" && path.isAbsolute(file) && fs.statSync(file).isFile()); } catch { return false; } };
  return {
    configured,
    async run(input, signal) {
      if (!configured()) throw new Error("未配置本地智能抠图运行环境和 U²-Net 模型。");
      if (!Buffer.isBuffer(input) || !input.length || input.length > 4 * 1024 * 1024) throw new Error("图片大小无效。");
      signal.throwIfAborted();
      return await new Promise((resolve, reject) => {
        const env = Object.fromEntries(["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE", "LANG", "LC_ALL"].filter(key => process.env[key]).map(key => [key, process.env[key]]));
        const child = spawnImpl(python, ["-I", "-X", "utf8", script, model], { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "ignore"], env });
        let length = 0, failure, spawnError; const chunks = [];
        const stop = () => child.kill();
        signal.addEventListener("abort", stop, { once: true }); if (signal.aborted) stop();
        const timer = setTimeout(() => { failure = new Error("智能抠图处理超时。"); stop(); }, 120_000);
        child.stdout.on("data", chunk => { length += chunk.length; if (length > 20 * 1024 * 1024) { failure = new Error("抠图结果超过大小限制。"); stop(); } else chunks.push(chunk); });
        child.once("error", error => { spawnError = error; });
        child.stdin.on("error", () => {}); child.stdin.end(input);
        child.once("close", code => {
          clearTimeout(timer); signal.removeEventListener("abort", stop);
          if (signal.aborted) return reject(signal.reason ?? new Error("抠图已取消。"));
          if (failure || spawnError || code !== 0) return reject(failure ?? new Error("本地智能抠图失败，请检查运行环境与模型。"));
          const result = Buffer.concat(chunks);
          if (!result.subarray(0, 8).equals(PNG)) return reject(new Error("抠图结果格式无效。"));
          resolve(result);
        });
      });
    },
  };
}
