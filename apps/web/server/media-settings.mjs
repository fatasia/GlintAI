import fs from "node:fs";
import path from "node:path";

const FILE_LIMIT = 8 * 1024;

/**
 * Persists the media gateway credentials for this machine. The key is never
 * returned by the read path; only a masked hint leaves the server.
 */
export function createMediaSettings({ file, env = process.env } = {}) {
  let saved = null;
  if (file && fs.existsSync(file) && fs.statSync(file).size <= FILE_LIMIT) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (parsed && typeof parsed.baseUrl === "string" && typeof parsed.apiKey === "string") saved = { baseUrl: parsed.baseUrl, apiKey: parsed.apiKey, protocol: ["skills", "openai-images"].includes(parsed.protocol) ? parsed.protocol : "skills" };
    } catch { saved = null; }
  }
  const effective = () => ({
    baseUrl: saved?.baseUrl ?? (typeof env.GLINT_MEDIA_BASE_URL === "string" ? env.GLINT_MEDIA_BASE_URL : ""),
    apiKey: saved?.apiKey ?? (typeof env.GLINT_MEDIA_API_KEY === "string" ? env.GLINT_MEDIA_API_KEY : ""),
    protocol: saved?.protocol ?? (env.GLINT_MEDIA_PROTOCOL === "openai-images" ? "openai-images" : "skills"),
  });
  const validate = (value, current = { apiKey: "", baseUrl: "", protocol: "skills" }) => {
    if (!value || typeof value !== "object") throw new Error("Media settings must be an object");
    const { baseUrl } = value;
    const apiKey = typeof value.apiKey === "string" && value.apiKey ? value.apiKey : current.apiKey;
    const protocol = value.protocol ?? current.protocol ?? "skills";
    if (!["skills", "openai-images"].includes(protocol)) throw new Error("未知的网关协议");
    if (typeof baseUrl !== "string" || !baseUrl.trim()) throw new Error("请填写媒体网关地址");
    let url;
    try { url = new URL(baseUrl); } catch { throw new Error("媒体网关地址不是合法 URL"); }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("媒体网关必须是 https 地址，且不能带账号、查询参数或片段");
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (/^(?:localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|::1$|fc|fd|fe80)/i.test(host)) throw new Error("媒体网关不能指向本机或私有地址");
    // A saved/environment key must never be forwarded to a different origin.
    let currentUrl;
    try { currentUrl = current.baseUrl ? new URL(current.baseUrl) : null; } catch { currentUrl = null; }
    if (typeof value.apiKey !== "string" || !value.apiKey) {
      if (!current.apiKey) throw new Error("请填写 API Key（已保存的密钥只在留空时复用）");
      if (currentUrl && currentUrl.origin !== url.origin) throw new Error("更换网关地址需要重新填写 API Key");
    }
    if (!/^[A-Za-z0-9._-]{8,256}$/.test(apiKey)) throw new Error("API Key 格式不正确");
    return { baseUrl: url.origin + url.pathname.replace(/\/+$/, ""), apiKey, protocol };
  };
  return {
    read() {
      const { baseUrl, apiKey, protocol } = effective();
      return { baseUrl, protocol, configured: Boolean(baseUrl && apiKey), keyHint: apiKey ? (apiKey.length > 8 ? `…${apiKey.slice(-4)}` : "已配置") : "", source: saved ? "saved" : apiKey ? "environment" : "none" };
    },
    env() { return effective(); },
    save(value) {
      const next = validate(value, effective());
      if (!file) throw new Error("当前运行没有可写的设置目录");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temporary = `${file}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
      fs.renameSync(temporary, file);
      saved = next;
      return this.read();
    },
    clear() {
      saved = null;
      if (file && fs.existsSync(file)) fs.rmSync(file, { force: true });
      return this.read();
    },
  };
}
