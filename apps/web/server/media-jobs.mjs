import fs from "node:fs";
import { projectMediaCatalog, supportsMediaCapability } from "@glintai/models";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { MediaGatewayClient, downloadMediaResult } from "@glintai/media";
import { createLibraryWriter, probeIngest } from "./media-library.mjs";
import { downloadTerminalResult, resolveMediaTaskStatus } from "./media-task-status.mjs";
import { mediaSpend } from "./media-spend.mjs";
import { createComfyMediaAdapter } from "./comfyui-media-adapter.mjs";

export function createMediaJobs(root, env = process.env, dependencies = {}) {
  fs.mkdirSync(root, { recursive: true });
  root = path.resolve(root);
  const writer = createLibraryWriter(root);
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
  let executionGuard, cloudAdapter;
  const libraryAsset = asset, comfyui = createComfyMediaAdapter({ root, env, writer, asset, probe: probeIngest });
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
  const { readSpend, recordSpend } = mediaSpend(root, taskFile, writeAtomic);
  return {
    setExecutionGuard(guard) { executionGuard = guard; },
    setCloudAdapter(adapter) { cloudAdapter = adapter; },
    comfyui, configured: () => Boolean(env.GLINT_MEDIA_BASE_URL && env.GLINT_MEDIA_API_KEY),
    protocol,
    /** Copy one library image to a content-addressed file without ever overwriting. */
    pinReference(name) {
      const source = asset(name);
      if (!source || !/\.(png|jpg|webp)$/.test(name) || fs.realpathSync(root) !== realRoot) throw new Error("参考图不在受控素材库中。");
      const size = fs.statSync(source).size;
      if (size < 1 || size > 8 * 1024 * 1024) throw new Error("参考图必须小于等于 8 MiB。");
      const bytes = fs.readFileSync(source), extension = imageExtension(bytes);
      if (bytes.length !== size || extension !== path.extname(name).slice(1)) throw new Error("参考图格式或文件内容无效。");
      const sha256 = createHash("sha256").update(bytes).digest("hex"), targetName = `approved-${sha256}.${extension}`, target = path.join(root, targetName), temporary = path.join(root, `.approval-${randomUUID()}.part`);
      try {
        fs.writeFileSync(temporary, bytes, { flag: "wx" });
        try { fs.linkSync(temporary, target); }
        catch (error) { if (error?.code !== "EEXIST") throw error; }
        const stored = asset(targetName);
        if (!stored || fs.statSync(stored).size !== bytes.length || createHash("sha256").update(fs.readFileSync(stored)).digest("hex") !== sha256) throw new Error("内容寻址素材已损坏或被替换，未批准。");
        return { name: targetName, sha256 };
      } finally { try { fs.unlinkSync(temporary); } catch (error) { if (error?.code !== "ENOENT") throw error; } }
    },
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
      if (protocol() !== "openai-images") return projectMediaCatalog(await client().models(type), type, protocol());
      if (!env.GLINT_MEDIA_BASE_URL || !env.GLINT_MEDIA_API_KEY) return [];
      // The OpenAI model list mixes chat and image models; show the plausible image
      // subset, but fall back to the full list rather than locking out a gateway
      // whose naming we do not recognize.
      if (type !== "image") return [];
      const data = await openaiJson("/v1/models");
      const list = (data.data ?? []).filter((item) => typeof item?.id === "string").map(item => ({ id: item.id, name: item.id, type }));
      const images = list.filter(item => imageModel.test(item.id));
      return projectMediaCatalog(images, type, protocol());
    },
    pricing: async (model, signal) => client().pricing(model, signal),
    findRequest(id) {
      if (!valid(id)) return null;
      if (fs.lstatSync(root).isSymbolicLink() || fs.realpathSync(root) !== realRoot) throw new Error("Media library changed");
      const file = path.join(root, `request-${id}.json`);
      if (!fs.existsSync(file)) return null;
      if (fs.lstatSync(file).isSymbolicLink() || !fs.lstatSync(file).isFile()) throw new Error("Invalid media record");
      const record = JSON.parse(fs.readFileSync(file, "utf8"));
      if (record.protocol === "comfyui") return comfyui.findRequest(id);
      return record.taskId ? { taskId: record.taskId } : null;
    },
    async submit(input, signal) {
      if (!["image", "video", "audio"].includes(input.type) || typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 4000 || !valid(input.requestId) || typeof input.model !== "string" || !input.model.trim() || !input.params || typeof input.params !== "object" || Array.isArray(input.params)) throw new Error("Invalid media input");
      const openai = protocol() === "openai-images";
      if (openai && input.type !== "image") throw new Error("OpenAI Images protocol only generates images; switch the media protocol to skills for video or audio");
      let reference, referenceImage = input.referenceImage, referenceSha256 = input.referenceSha256;
      if (input.canvasReference !== undefined) {
        const ref = input.canvasReference;
        if (referenceImage !== undefined || !ref || typeof ref !== "object" || !valid(ref.taskId) || !/^[a-f0-9]{64}$/.test(ref.sha256 ?? "")) throw new Error("画布参考图回执无效。");
        const sourceFile = taskFile(ref.taskId);
        if (!fs.existsSync(sourceFile)) throw new Error("找不到参考图任务。");
        const source = JSON.parse(fs.readFileSync(sourceFile, "utf8"));
        if (source.type !== "image" || source.cancelled || !source.isFinal || source.state !== "success") throw new Error("参考图任务尚未成功完成。");
        const candidates = ["png", "jpg", "webp"].map(ext => `${ref.taskId}.${ext}`).filter(name => asset(name));
        if (candidates.length !== 1) throw new Error("参考图任务缺少唯一素材。");
        referenceImage = candidates[0]; referenceSha256 = ref.sha256;
      }
      if (referenceImage !== undefined) {
        if (openai || input.type !== "image" || typeof referenceImage !== "string" || Object.hasOwn(input.params, "images")) throw new Error("This protocol does not support the approved reference option");
        const catalog = await client().models("image");
        const model = catalog.find(item => item.id === input.model);
        if (!supportsMediaCapability(model, protocol(), "reference-image")) throw new Error("所选模型未声明支持图片参考，未提交任务。");
        const file = asset(referenceImage);
        if (!file || !/\.(png|jpg|webp)$/.test(referenceImage)) throw new Error("参考图不在本机素材库中。");
        const size = fs.statSync(file).size;
        if (size < 1 || size > 8 * 1024 * 1024) throw new Error("参考图必须小于等于 8 MiB。");
        const bytes = fs.readFileSync(file);
        if (bytes.length !== size || imageExtension(bytes) !== path.extname(file).slice(1)) throw new Error("参考图格式或文件内容无效。");
        const hash = createHash("sha256").update(bytes).digest("hex");
        if (typeof referenceSha256 !== "string" || referenceSha256 !== hash) throw new Error("批准参考图内容已变化，请创建新版本重新批准。");
        reference = { bytes, hash, mime: referenceImage.endsWith(".jpg") ? "image/jpeg" : `image/${path.extname(file).slice(1)}` };
      }
      const requestFile = path.join(root, `request-${input.requestId}.json`), signature = JSON.stringify([input.type, input.model, input.prompt, input.params, ...(input.bindingId ? [{ bindingId: input.bindingId, quoteId: input.quoteId }] : []), ...(reference ? [{ image: referenceImage, sha256: reference.hash, binding: input.referenceBinding, canvasTask: input.canvasReference?.taskId }] : [])]);
      if (fs.existsSync(requestFile)) {
        const previous = JSON.parse(fs.readFileSync(requestFile, "utf8"));
        if (previous.signature !== signature) throw new Error("Request ID belongs to different input");
        if (!previous.taskId) throw new Error("Submission is uncertain or pending; inspect the gateway before resubmitting");
        return { taskId: previous.taskId };
      }
      if (executionGuard) await executionGuard(input, openai ? "openai-images" : "skills-gateway");
      const budget = Number(env.GLINT_MEDIA_BUDGET);
      if (Number.isFinite(budget) && budget > 0) {
        const spend = readSpend();
        if (spend.total >= budget) throw new Error(`本地预算已用尽：已花费 ${spend.total.toFixed(2)} 算力，上限 ${budget}；可在媒体设置调高 GLINT_MEDIA_BUDGET`);
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
      let taskId, resultUrl, outputAsset;
      try {
        if (openai) ({ taskId, resultUrl, asset: outputAsset } = await submitOpenai(input, signal));
        else taskId = await client().submit(input.model, input.prompt, reference ? { ...input.params, images: [`data:${reference.mime};base64,${reference.bytes.toString("base64")}`] } : input.params, signal);
      } catch (error) {
        // Only definite client rejections are safe to retry; 408/409/425 may still be in flight.
        if (openai && [400, 401, 403, 404, 422, 429].includes(Number(error?.status))) fs.rmSync(requestFile, { force: true });
        throw error;
      }
      const createdAt = new Date().toISOString();
      const record = openai
        ? { taskId, type: "image", model: input.model, createdAt, protocol: "openai-images", state: "success", isFinal: true, ...(resultUrl ? { resultUrl } : {}), ...(outputAsset ? { asset: outputAsset } : {}) }
        : { taskId, type: input.type, model: input.model, createdAt, protocol: "skills", ...(reference && input.referenceBinding ? { referenceBinding: input.referenceBinding } : {}) };
      fs.writeFileSync(taskFile(taskId), JSON.stringify(record));
      fs.writeFileSync(requestFile, JSON.stringify({ signature, taskId }));
      return { taskId };
    },
    async status(id, signal) {
      if (id.startsWith("cloud-") && cloudAdapter) return cloudAdapter.status(id, signal);
      if (!valid(id) || !fs.existsSync(taskFile(id))) throw new Error("Unknown media task");
      if (fs.lstatSync(root).isSymbolicLink() || fs.realpathSync(root) !== realRoot || fs.lstatSync(taskFile(id)).isSymbolicLink() || !fs.lstatSync(taskFile(id)).isFile()) throw new Error("Invalid media record");
      const local = JSON.parse(fs.readFileSync(taskFile(id), "utf8"));
      if (local.protocol === "comfyui") return comfyui.status(id, signal);
      // A detached (cancelled) task never reaches the gateway again: no state,
      // no download, no spend. The record stays for the requestId audit trail.
      if (local.cancelled) return { taskId: id, type: local.type, model: local.model, createdAt: local.createdAt, state: "cancelled", isFinal: true };
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
      const { task } = await resolveMediaTaskStatus(id, () => JSON.parse(fs.readFileSync(taskFile(id), "utf8")), record => writeAtomic(taskFile(id), JSON.stringify(record)), () => client().status(id, signal));
      const current = JSON.parse(fs.readFileSync(taskFile(id), "utf8"));
      if (current.cancelled) return { taskId: id, type: current.type, model: current.model, createdAt: current.createdAt, state: "cancelled", isFinal: true };
      let asset;
      if (task.is_final && task.state === "success") {
        recordSpend(id, task.cost);
        const save = async () => {
          const result = await downloadTerminalResult(task, () => downloadResult(task, AbortSignal.timeout(120_000)), () => JSON.parse(fs.readFileSync(taskFile(id), "utf8")), record => writeAtomic(taskFile(id), JSON.stringify(record)));
          const extension = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "video/mp4": "mp4", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav" }[result.contentType];
          if (!extension) throw new Error("Unsupported generated media format");
          if (local.referenceBinding && (!["png", "jpg", "webp"].includes(extension) || !result.bytes?.length || result.bytes.length > 10 * 1024 * 1024 || imageExtension(result.bytes) !== extension)) throw new Error("下载候选格式无效，未建立采用回执。");
          const file = `${id}.${extension}`; writeAtomic(path.join(root, file), result.bytes);
          const rejected = probeIngest(path.join(root, file), local.type);
          if (rejected) { fs.rmSync(path.join(root, file), { force: true }); throw new Error(`Generated ${local.type} failed the ingest check: ${rejected}`); }
          if (local.referenceBinding) {
            const stored = libraryAsset(file);
            if (!stored || !/\.(png|jpg|webp)$/.test(file)) throw new Error("参考图任务的候选不是有效图片。");
            const bytes = fs.readFileSync(stored);
            if (bytes.length !== result.bytes.length || bytes.length > 10 * 1024 * 1024 || imageExtension(bytes) !== extension || createHash("sha256").update(bytes).digest("hex") !== createHash("sha256").update(result.bytes).digest("hex")) throw new Error("下载候选已变化，未建立采用回执。");
            const latest = JSON.parse(fs.readFileSync(taskFile(id), "utf8"));
            writeAtomic(taskFile(id), JSON.stringify({ ...latest, candidateReceipt: { file, sha256: createHash("sha256").update(bytes).digest("hex") } }));
          }
          return file;
        };
        const existing = fs.readdirSync(root).find(file => file.startsWith(`${id}.`) && !file.endsWith(".json"));
        if (existing) {
          if (local.referenceBinding) {
            const latest = JSON.parse(fs.readFileSync(taskFile(id), "utf8"));
            if (!latest.candidateReceipt || latest.candidateReceipt.file !== existing) throw new Error("候选缺少可信下载回执，请手动从素材库选用。");
          }
          asset = existing;
        }
        else {
          if (!downloads.has(id)) downloads.set(id, save().finally(() => downloads.delete(id)));
          asset = await downloads.get(id);
        }
      }
      const { referenceBinding: _binding, candidateReceipt: _receipt, terminalReceipt: _terminal, ...publicRecord } = local;
      return { ...publicRecord, state: task.state, isFinal: task.is_final, cost: task.cost, ...(asset ? { assetUrl: `/api/media/assets/${asset}` } : {}) };
    },
    /** Read only a locally completed task and its approved reference provenance. */
    referenceCandidate(id) {
      if (!valid(id) || !fs.existsSync(taskFile(id))) throw new Error("找不到已完成的参考图任务。");
      const task = JSON.parse(fs.readFileSync(taskFile(id), "utf8"));
      if (task.cancelled || !task.isFinal || task.state !== "success" || !task.referenceBinding) throw new Error("任务没有可验证的参考图记录，请手动从素材库选用。");
      const receipt = task.candidateReceipt;
      if (!receipt || typeof receipt.file !== "string" || !/^[a-f0-9]{64}$/.test(receipt.sha256 ?? "") || !new RegExp(`^${id}\\.(?:png|jpg|webp)$`).test(receipt.file)) throw new Error("候选缺少可信下载回执，请手动从素材库选用。");
      const file = asset(receipt.file);
      if (!file) throw new Error("候选素材已丢失。");
      const stat = fs.statSync(file);
      if (stat.size < 1 || stat.size > 10 * 1024 * 1024) throw new Error("候选素材大小无效。");
      const bytes = fs.readFileSync(file);
      if (bytes.length !== stat.size || imageExtension(bytes) !== path.extname(file).slice(1) || createHash("sha256").update(bytes).digest("hex") !== receipt.sha256) throw new Error("候选素材内容已变化，未采用。");
      return { ...task.referenceBinding, candidate: receipt.file, candidateBytes: bytes };
    },
    /** Preserve the verified candidate bytes independently of the source filename. */
    adoptCandidate(bytes, extension) {
      if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 10 * 1024 * 1024 || imageExtension(bytes) !== extension) throw new Error("候选内容无效，未采用。");
      if (!/^(?:png|jpg|webp)$/.test(extension)) throw new Error("候选类型不受支持，未采用。");
      if (fs.realpathSync(root) !== realRoot) throw new Error("素材库已变化，候选未采用。");
      const sha256 = createHash("sha256").update(bytes).digest("hex"), name = `adopted-${sha256}.${extension}`;
      const target = path.join(root, name), temporary = path.join(root, `.adoption-${randomUUID()}.part`);
      try {
        fs.writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
        try { fs.linkSync(temporary, target); }
        catch (error) { if (error?.code !== "EEXIST") throw error; }
        const file = asset(name);
        if (!file) throw new Error("受控副本不是普通素材文件，候选未采用。");
        const written = fs.readFileSync(file);
        if (written.length !== bytes.length || createHash("sha256").update(written).digest("hex") !== sha256) throw new Error("受控副本内容冲突或已变化，候选未采用。");
        return { name, sha256 };
      } finally { try { fs.unlinkSync(temporary); } catch (error) { if (error?.code !== "ENOENT") throw error; } }
    },
    verifyReference(name, sha256) {
      const file = asset(name);
      if (!file || !/\.(png|jpg|webp)$/.test(name)) throw new Error("批准参考图已丢失。");
      const stat = fs.statSync(file);
      if (stat.size < 1 || stat.size > 8 * 1024 * 1024) throw new Error("批准参考图大小无效。");
      const bytes = fs.readFileSync(file);
      if (bytes.length !== stat.size || imageExtension(bytes) !== path.extname(file).slice(1) || createHash("sha256").update(bytes).digest("hex") !== sha256) throw new Error("批准参考图内容已变化，候选未采用。");
    },
    /** Local spend ledger (OPS-02): accumulated from success receipts only. */
    spend: readSpend,
    portableChapterRoot() {
      const stat = fs.lstatSync(root);
      if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(root) !== realRoot) throw new Error("素材库目录已变化，无法安全迁移。");
      return root;
    },
    asset,
    upload: (stream, name, maxBytes) => writer.upload(stream, name, maxBytes),
    uploadImage: (stream, contentType, signal) => writer.uploadImage(stream, contentType, signal),
    install: writer.install,
    /** Client-side cancel (GEN-01): the gateway exposes no cancel endpoint, so a
     * cancel only detaches the local task — later polls return cancelled with no
     * gateway traffic, nothing is downloaded and no cost is recorded. Upstream may
     * still complete and bill; the ledger only ever counts polled success receipts. */
    cancel(id, signal) {
      if (id.startsWith("cloud-") && cloudAdapter) return cloudAdapter.cancel(id, signal);
      if (!valid(id) || !fs.existsSync(taskFile(id))) return null;
      if (fs.lstatSync(root).isSymbolicLink() || fs.realpathSync(root) !== realRoot || fs.lstatSync(taskFile(id)).isSymbolicLink() || !fs.lstatSync(taskFile(id)).isFile()) throw new Error("Invalid media record");
      const local = JSON.parse(fs.readFileSync(taskFile(id), "utf8"));
      if (local.protocol === "comfyui") return comfyui.cancel(id);
      if (local.cancelled) return { taskId: id, type: local.type, state: "cancelled", isFinal: true, cancelledAt: local.cancelledAt };
      if (local.isFinal || local.state === "success") return null;
      const cancelledAt = new Date().toISOString();
      writeAtomic(taskFile(id), JSON.stringify({ ...local, cancelled: true, cancelledAt }));
      return { taskId: id, type: local.type, state: "cancelled", isFinal: true, cancelledAt };
    },
  };
}
