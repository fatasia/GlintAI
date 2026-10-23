import fs from "node:fs";
import path from "node:path";
import { MediaGatewayClient, downloadMediaResult } from "@glintai/media";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
export function createMediaJobs(root, env = process.env, dependencies = {}) {
  fs.mkdirSync(root, { recursive: true });
  root = path.resolve(root);
  const realRoot = fs.realpathSync(root);
  function asset(name) {
    if (typeof name !== "string" || !/^[a-zA-Z0-9_-]{1,100}\.(?:png|jpg|webp|mp4|mp3|wav)(?![\s\S])/.test(name)) return null;
    try {
      const file = path.join(root, name), stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || !stat.isFile()) return null;
      // A junction swap of the library root must not expose files outside it.
      if (fs.realpathSync(path.dirname(file)) !== realRoot) return null;
      return file;
    } catch { return null; }
  }
  const taskFile = id => path.join(root, `${id}.json`);
  const valid = id => typeof id === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(id);
  const protocol = () => env.GLINT_MEDIA_PROTOCOL === "openai-images" ? "openai-images" : "skills";
  const client = () => {
    if (!env.GLINT_MEDIA_BASE_URL || !env.GLINT_MEDIA_API_KEY) throw new Error("Configure a media gateway");
    return dependencies.client ?? new MediaGatewayClient({ baseUrl: env.GLINT_MEDIA_BASE_URL, apiKey: env.GLINT_MEDIA_API_KEY });
  };
  // OpenAI-compatible image endpoints live next to /v1; the settings UI may store either form.
  const openaiBase = () => {
    let url;
    try { url = new URL(env.GLINT_MEDIA_BASE_URL); } catch { throw new Error("Media gateway URL is not valid; open connection settings and save it again"); }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Media gateway requires a credential-free HTTPS base URL");
    return `${url.origin}${url.pathname}`.replace(/\/+$/, "").replace(/\/v1$/, "");
  };
  async function openaiJson(route, body, signal = AbortSignal.timeout(120000)) {
    const response = await (dependencies.fetchImpl ?? fetch)(`${openaiBase()}${route}`, { method: body === undefined ? "GET" : "POST", redirect: "error", headers: { authorization: `Bearer ${env.GLINT_MEDIA_API_KEY}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal });
    if (!response.body) throw Object.assign(new Error("Empty media gateway response"), { status: response.status });
    const reader = response.body.getReader(), chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 2 * 1024 * 1024) { await reader.cancel(); throw Object.assign(new Error("Media gateway response exceeds 2 MiB"), { status: 502 }); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    let data;
    try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw Object.assign(new Error(`Media gateway returned a non-JSON response (HTTP ${response.status}); check the gateway address`), { status: response.status }); }
    if (!response.ok || (data?.code && data.code !== 0)) throw Object.assign(new Error(data?.error?.message ?? data?.msg ?? `Media gateway returned HTTP ${response.status}`), { status: response.status });
    return data;
  }
  const writeAtomic = (file, bytes) => {
    const temporary = `${file}.${process.pid}.${Date.now()}.part`;
    fs.writeFileSync(temporary, bytes);
    fs.renameSync(temporary, file);
  };
  const imageModel = /(?:gpt-image|dall-?e|flux|seedream|imagen|image|banana|kolors|midjourney)/i;
  const imageExtension = bytes => bytes.subarray(0, 4).toString("hex") === "89504e47" ? "png" : bytes[0] === 0xff && bytes[1] === 0xd8 ? "jpg" : bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP" ? "webp" : null;
  const downloads = new Map();
  // TUN/Fake-IP setups resolve CDN names to a private address, which the safe
  // downloader rejects. Retry once through public DNS; the address is still
  // validated and pinned, so this is not a private-IP bypass.
  async function downloadResult(task, signal) {
    const download = dependencies.download ?? downloadMediaResult;
    const forced = env.GLINT_MEDIA_PUBLIC_DNS === "1";
    try { return await download(task, signal, { publicDns: forced }); }
    catch (error) {
      if (forced || !/Private, loopback or reserved/.test(String(error?.message ?? ""))) throw error;
      return download(task, signal, { publicDns: true });
    }
  }
  async function submitOpenai(input, signal) {
    const size = typeof input.params.size === "string" && /^\d{2,5}x\d{2,5}$/.test(input.params.size) ? input.params.size : "1024x1024";
    const data = await openaiJson("/v1/images/generations", { model: input.model, prompt: input.prompt, n: 1, size, response_format: "url" }, signal);
    const item = data?.data?.[0];
    const taskId = `img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    if (typeof item?.url === "string" && /^https:\/\//.test(item.url)) return { taskId, resultUrl: item.url };
    // Some OpenAI-compatible gateways ignore response_format and return base64 anyway.
    if (typeof item?.b64_json === "string" && item.b64_json.length > 100) {
      if (item.b64_json.length > 14_000_000) throw new Error("Gateway returned an image larger than 10 MiB");
      const bytes = Buffer.from(item.b64_json, "base64"), extension = imageExtension(bytes);
      if (!extension) throw new Error("Gateway returned an unsupported image payload");
      if (bytes.length > 10 * 1024 * 1024) throw new Error("Gateway returned an image larger than 10 MiB");
      writeAtomic(path.join(root, `${taskId}.${extension}`), bytes);
      return { taskId, asset: `${taskId}.${extension}` };
    }
    throw new Error("Gateway did not return an image URL or base64 payload; confirm the selected model generates images");
  }
  const stock = name => { try { return fs.statSync(path.join(root, name)).isFile() ? name : null; } catch { return null; } };
  return {
    configured: () => Boolean(env.GLINT_MEDIA_BASE_URL && env.GLINT_MEDIA_API_KEY),
    protocol,
    /** Apply credentials saved from the settings UI without recreating the queue. */
    applyEnv(patch = {}) { Object.assign(env, patch); },
    library: () => fs.readdirSync(root).flatMap(name => {
      const file = asset(name);
      if (!file) return [];
      const stat = fs.statSync(file);
      return [{ name, url: `/api/media/assets/${name}`, bytes: stat.size, mtime: stat.mtimeMs }];
    }),
    /** Non-destructive edit chain written by `glint image-edit` (versions.json in the media root). */
    versions() {
      const file = path.join(root, "versions.json");
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return [];
      if (fs.statSync(file).size > 2 * 1024 * 1024) throw new Error("versions.json is too large");
      let chain;
      try { chain = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return []; }
      if (!Array.isArray(chain)) return [];
      const safe = name => typeof name === "string" && /^[a-zA-Z0-9_-]{1,100}\.(?:png|jpg|webp)$/.test(name);
      return chain.slice(0, 200).filter(entry => entry && safe(entry.file)).map(entry => ({
        file: entry.file,
        parent: safe(entry.parent) ? entry.parent : null,
        model: typeof entry.model === "string" ? entry.model.slice(0, 120) : "",
        prompt: typeof entry.prompt === "string" ? entry.prompt.slice(0, 2000) : "",
        cost: Number.isFinite(entry.cost) ? entry.cost : undefined,
        at: typeof entry.at === "string" && Number.isFinite(Date.parse(entry.at)) ? entry.at : undefined,
        url: `/api/media/assets/${entry.file}`,
      }));
    },
    models: async type => {
      if (protocol() !== "openai-images") return client().models(type);
      if (!env.GLINT_MEDIA_BASE_URL || !env.GLINT_MEDIA_API_KEY) return [];
      // The OpenAI model list mixes chat and image models; show the plausible image
      // subset, but fall back to the full list rather than locking out a gateway
      // whose naming we do not recognize.
      if (type !== "image") return [];
      const data = await openaiJson("/v1/models");
      const list = (data.data ?? []).filter((item) => typeof item?.id === "string").map(item => ({ id: item.id, name: item.id, type }));
      const images = list.filter(item => imageModel.test(item.id));
      return images;
    },
    findRequest(id) {
      if (!valid(id)) return null;
      const file = path.join(root, `request-${id}.json`);
      if (!fs.existsSync(file)) return null;
      const record = JSON.parse(fs.readFileSync(file, "utf8"));
      return record.taskId ? { taskId: record.taskId } : null;
    },
    async submit(input, signal) {
      if (!["image", "video", "audio"].includes(input.type) || typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 4000 || !valid(input.requestId) || typeof input.model !== "string" || !input.model.trim() || !input.params || typeof input.params !== "object" || Array.isArray(input.params)) throw new Error("Invalid media input");
      const openai = protocol() === "openai-images";
      if (openai && input.type !== "image") throw new Error("OpenAI Images protocol only generates images; switch the media protocol to skills for video or audio");
      const requestFile = path.join(root, `request-${input.requestId}.json`), signature = JSON.stringify([input.type, input.model, input.prompt, input.params]);
      if (fs.existsSync(requestFile)) {
        const previous = JSON.parse(fs.readFileSync(requestFile, "utf8"));
        if (previous.signature !== signature) throw new Error("Request ID belongs to different input");
        if (!previous.taskId) throw new Error("Submission is uncertain or pending; inspect the gateway before resubmitting");
        return { taskId: previous.taskId };
      }
      try {
        fs.writeFileSync(requestFile, JSON.stringify({ signature, createdAt: new Date().toISOString() }), { flag: "wx" });
      } catch (error) {
        if (error?.code === "EEXIST") {
          const previous = JSON.parse(fs.readFileSync(requestFile, "utf8"));
          if (previous.signature === signature && previous.taskId) return { taskId: previous.taskId };
          throw Object.assign(new Error("This request is already being submitted; wait for its receipt before retrying"), { status: 409 });
        }
        throw error;
      }
      let taskId, resultUrl, asset;
      try {
        if (openai) ({ taskId, resultUrl, asset } = await submitOpenai(input, signal));
        else taskId = await client().submit(input.model, input.prompt, input.params, signal);
      } catch (error) {
        // Only definite client rejections are safe to retry; 408/409/425 may still be in flight.
        if (openai && [400, 401, 403, 404, 422, 429].includes(Number(error?.status))) fs.rmSync(requestFile, { force: true });
        throw error;
      }
      const createdAt = new Date().toISOString();
      const record = openai
        ? { taskId, type: "image", model: input.model, createdAt, protocol: "openai-images", state: "success", isFinal: true, ...(resultUrl ? { resultUrl } : {}), ...(asset ? { asset } : {}) }
        : { taskId, type: input.type, model: input.model, createdAt, protocol: "skills" };
      fs.writeFileSync(taskFile(taskId), JSON.stringify(record));
      fs.writeFileSync(requestFile, JSON.stringify({ signature, taskId }));
      return { taskId };
    },
    async status(id, signal) {
      if (!valid(id) || !fs.existsSync(taskFile(id))) throw new Error("Unknown media task");
      const local = JSON.parse(fs.readFileSync(taskFile(id), "utf8"));
      const taskProtocol = local.protocol === "openai-images" ? "openai-images" : "skills";
      if (taskProtocol === "openai-images") {
        if (local.state !== "success") throw new Error("Image task is not complete; refresh its status");
        let asset = local.asset ? stock(local.asset) : null;
        if (!asset) asset = fs.readdirSync(root).find(file => file.startsWith(`${id}.`) && !file.endsWith(".json")) ?? null;
        if (!asset) {
          if (typeof local.resultUrl !== "string") throw new Error("Image task has no downloadable result; check the gateway response");
          if (!downloads.has(id)) downloads.set(id, (async () => {
            // The download must outlive the HTTP request that happened to trigger it.
            const result = await downloadResult({ task_id: id, state: "success", is_final: true, result_url: local.resultUrl }, AbortSignal.timeout(120_000));
            const extension = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }[result.contentType] ?? imageExtension(result.bytes);
            if (!extension) throw new Error("Unsupported generated image format");
            const file = `${id}.${extension}`;
            writeAtomic(path.join(root, file), result.bytes);
            fs.writeFileSync(taskFile(id), JSON.stringify({ ...local, asset: file }));
            return file;
          })().finally(() => downloads.delete(id)));
          asset = await downloads.get(id);
        }
        return { taskId: id, type: "image", model: local.model, createdAt: local.createdAt, state: "success", isFinal: true, ...(Number.isFinite(local.cost) ? { cost: local.cost } : {}), assetUrl: `/api/media/assets/${asset}` };
      }
      const task = await client().status(id, signal);
      let asset;
      if (task.is_final && task.state === "success") {
        const save = async () => {
          const result = await downloadResult(task, AbortSignal.timeout(120_000));
          const extension = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "video/mp4": "mp4", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav" }[result.contentType];
          if (!extension) throw new Error("Unsupported generated media format");
          const file = `${id}.${extension}`; writeAtomic(path.join(root, file), result.bytes); return file;
        };
        const existing = fs.readdirSync(root).find(file => file.startsWith(`${id}.`) && !file.endsWith(".json"));
        if (existing) asset = existing;
        else {
          if (!downloads.has(id)) downloads.set(id, save().finally(() => downloads.delete(id)));
          asset = await downloads.get(id);
        }
      }
      return { ...local, state: task.state, isFinal: task.is_final, cost: task.cost, ...(asset ? { assetUrl: `/api/media/assets/${asset}` } : {}) };
    },
    asset,
    /** Stream an upload into the library; never buffers the whole body in memory. */
    async upload(stream, name, maxBytes = 300 * 1024 * 1024) {
      if (typeof name !== "string" || !/^[a-zA-Z0-9_-]{1,100}\.mp4$/.test(name)) throw new Error("Upload name must be a safe .mp4 file name");
      const destination = path.join(root, name);
      if (fs.existsSync(destination)) throw new Error("Upload name already exists");
      const temporary = path.join(root, `.incoming-${name}`);
      let bytes = 0;
      const limiter = new Transform({ transform(chunk, _encoding, done) {
        bytes += chunk.length;
        if (bytes > maxBytes) { done(Object.assign(new Error("Reference upload is too large"), { status: 413 })); return; }
        done(null, chunk);
      } });
      try {
        await pipeline(stream, limiter, fs.createWriteStream(temporary, { flags: "wx" }));
        if (bytes < 1) throw Object.assign(new Error("Reference upload is empty"), { status: 400 });
        fs.renameSync(temporary, destination);
        return { name, bytes };
      } catch (error) {
        try { fs.rmSync(temporary, { force: true }); } catch { /* best-effort cleanup */ }
        throw error;
      }
    },
    /** Copy an existing local file into the library under a fresh safe name. */
    install(source, name) {
      if (typeof name !== "string" || !/^[a-zA-Z0-9_-]{1,100}\.(?:png|jpg|webp|mp4|mp3|wav)$/.test(name)) throw new Error("Invalid media name");
      if (typeof source !== "string" || !path.isAbsolute(source)) throw new Error("Source must be an absolute path");
      const stat = fs.lstatSync(source);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Source must be a regular file");
      const destination = path.join(root, name);
      if (fs.existsSync(destination)) throw new Error("Media name already exists");
      fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
      return name;
    },
  };
}
