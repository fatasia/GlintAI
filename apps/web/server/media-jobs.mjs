import fs from "node:fs";
import path from "node:path";
import { MediaGatewayClient, downloadMediaResult } from "@glintai/media";
export function createMediaJobs(root, env = process.env, dependencies = {}) {
  fs.mkdirSync(root, { recursive: true });
  const taskFile = id => path.join(root, `${id}.json`);
  const valid = id => typeof id === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(id);
  const client = () => {
    if (!env.GLINT_MEDIA_BASE_URL || !env.GLINT_MEDIA_API_KEY) throw new Error("Configure a media gateway");
    return dependencies.client ?? new MediaGatewayClient({ baseUrl: env.GLINT_MEDIA_BASE_URL, apiKey: env.GLINT_MEDIA_API_KEY });
  };
  const downloads = new Map();
  return {
    configured: () => Boolean(env.GLINT_MEDIA_BASE_URL && env.GLINT_MEDIA_API_KEY),
    library: () => fs.readdirSync(root).filter(file => /^[a-zA-Z0-9_-]{1,100}\.(?:png|jpg|webp|mp4|mp3|wav)$/.test(file)).map(file => ({ name: file, url: `/api/media/assets/${file}`, bytes: fs.statSync(path.join(root, file)).size })),
    models: type => client().models(type),
    findRequest(id) {
      if (!valid(id)) return null;
      const file = path.join(root, `request-${id}.json`);
      if (!fs.existsSync(file)) return null;
      const record = JSON.parse(fs.readFileSync(file, "utf8"));
      return record.taskId ? { taskId: record.taskId } : null;
    },
    async submit(input, signal) {
      if (!["image", "video", "audio"].includes(input.type) || typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 4000 || !valid(input.requestId) || typeof input.model !== "string" || !input.model.trim() || !input.params || typeof input.params !== "object" || Array.isArray(input.params)) throw new Error("Invalid media input");
      const requestFile = path.join(root, `request-${input.requestId}.json`), signature = JSON.stringify([input.type, input.model, input.prompt, input.params]);
      if (fs.existsSync(requestFile)) {
        const previous = JSON.parse(fs.readFileSync(requestFile, "utf8"));
        if (previous.signature !== signature) throw new Error("Request ID belongs to different input");
        if (!previous.taskId) throw new Error("Submission is uncertain or pending; inspect the gateway before resubmitting");
        return { taskId: previous.taskId };
      }
      fs.writeFileSync(requestFile, JSON.stringify({ signature, createdAt: new Date().toISOString() }), { flag: "wx" });
      const taskId = await client().submit(input.model, input.prompt, input.params, signal);
      const record = { taskId, type: input.type, model: input.model, createdAt: new Date().toISOString() };
      fs.writeFileSync(taskFile(taskId), JSON.stringify(record));
      fs.writeFileSync(requestFile, JSON.stringify({ signature, taskId }));
      return { taskId };
    },
    async status(id, signal) {
      if (!valid(id) || !fs.existsSync(taskFile(id))) throw new Error("Unknown media task");
      const local = JSON.parse(fs.readFileSync(taskFile(id), "utf8")), task = await client().status(id, signal);
      let asset;
      if (task.is_final && task.state === "success") {
        const save = async () => {
          const result = await (dependencies.download ?? downloadMediaResult)(task, signal, { publicDns: env.GLINT_MEDIA_PUBLIC_DNS === "1" });
          const extension = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "video/mp4": "mp4", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav" }[result.contentType];
          if (!extension) throw new Error("Unsupported generated media format");
          const file = `${id}.${extension}`; fs.writeFileSync(path.join(root, file), result.bytes); return file;
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
    asset(name) {
      if (!/^[a-zA-Z0-9_-]{1,100}\.(?:png|jpg|webp|mp4|mp3|wav)$/.test(name)) return null;
      const file = path.join(root, name); return fs.existsSync(file) ? file : null;
    },
  };
}
