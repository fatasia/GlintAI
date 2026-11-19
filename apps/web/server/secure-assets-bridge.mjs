import { spawn } from "node:child_process";
import path from "node:path";

const LIMIT = 32 * 1024 * 1024;
const TIMEOUT = 30_000;
const HELLO = "glint-secure-assets-v1";

/** Isolated bridge capability. It does not authenticate the caller or exclude same-user writers. */
export async function openSecureAssets(executable, root, { signal, timeout = TIMEOUT } = {}) {
  if (process.platform !== "win32" || !path.win32.isAbsolute(executable) || !path.win32.isAbsolute(root)) throw new Error("安全素材桥仅支持绝对路径的 Windows 本地目录。");
  if (signal?.aborted) throw signal.reason ?? new Error("素材操作已取消。");
  const child = spawn(executable, [root], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true, shell: false });
  let buffered = Buffer.alloc(0), pending, failure, closed = false;
  const fail = error => {
    failure ??= error;
    if (pending) { const item = pending; pending = undefined; clearTimeout(item.timer); item.reject(failure); }
    if (!closed) child.kill();
  };
  const abort = () => fail(signal.reason ?? new Error("素材操作已取消。"));
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  child.once("error", () => fail(new Error("无法启动安全素材桥。")));
  child.once("close", () => { closed = true; signal?.removeEventListener("abort", abort); fail(new Error("安全素材桥已退出。")); });
  child.stdin.on("error", () => fail(new Error("安全素材桥输入失败。")));
  child.stdout.on("data", chunk => {
    if (!pending || buffered.length + chunk.length > LIMIT + 5) return fail(new Error("安全素材桥响应无效。"));
    buffered = Buffer.concat([buffered, chunk]);
    if (buffered.length < 5) return;
    const length = buffered.readUInt32LE(1);
    if (length > LIMIT || buffered.length > length + 5) return fail(new Error("安全素材桥响应无效。"));
    if (buffered.length !== length + 5) return;
    const status = buffered[0], data = buffered.subarray(5);
    buffered = Buffer.alloc(0);
    const item = pending; pending = undefined; clearTimeout(item.timer);
    if (status === 0) item.resolve(data);
    else if (status <= 3) item.reject(Object.assign(new Error(status === 2 ? "素材名称冲突：已有文件内容不一致，未覆盖。" : "安全素材操作被拒绝。"), { code: status === 1 ? "ENOENT" : status === 2 ? "EEXIST" : "EACCES" }));
    else { item.reject(new Error("安全素材桥响应无效。")); fail(new Error("安全素材桥响应无效。")); }
  });
  function receive() {
    if (failure) return Promise.reject(failure);
    if (pending) return Promise.reject(new Error("安全素材桥不支持并发请求。"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error("安全素材桥操作超时。")), timeout);
      pending = { resolve, reject, timer };
    });
  }
  try {
    const hello = await receive();
    if (hello.toString() !== HELLO) throw new Error("安全素材桥版本不匹配。");
  } catch (error) { fail(error); throw error; }
  async function request(op, name, bytes = Buffer.alloc(0)) {
    const asset = typeof name === "string" && /^[a-zA-Z0-9_-]{1,100}\.(png|jpg|webp|mp4|mp3|wav)$/.test(name);
    const document = typeof name === "string" && name.length <= 255 && name.endsWith(".json") && !/[<>:"/\\|?*\x00-\x1f]/.test(name) && !/[ .]\.json$/.test(name);
    if ((!asset && !document) || !Buffer.isBuffer(bytes) || bytes.length > LIMIT) throw new Error("素材请求无效。");
    if (failure) throw failure;
    if (pending) throw new Error("安全素材桥不支持并发请求。");
    const encoded = Buffer.from(name), header = Buffer.alloc(9);
    header[0] = op; header.writeUInt32LE(encoded.length, 1); header.writeUInt32LE(bytes.length, 5);
    const result = receive();
    if (!pending) return result;
    child.stdin.write(Buffer.concat([header, encoded, bytes]));
    return result;
  }
  return {
    isUsable: () => !failure && !closed,
    read: name => request(1, name),
    publish: (name, bytes) => request(2, name, bytes).then(value => value.toString()),
    async close() {
      if (closed) return;
      const done = new Promise(resolve => child.once("close", resolve));
      signal?.removeEventListener("abort", abort);
      fail(new Error("安全素材桥已关闭。"));
      child.stdin.end();
      await done;
    },
  };
}
