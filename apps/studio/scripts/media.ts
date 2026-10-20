import fs from "node:fs";
import path from "node:path";
import { MediaGatewayClient, downloadMediaResult } from "@glintai/media";
import { readArg } from "./glint-runtime";
const args = process.argv.slice(2);
const baseUrl = process.env.GLINT_MEDIA_BASE_URL, apiKey = process.env.GLINT_MEDIA_API_KEY;
if (!baseUrl || !apiKey) throw new Error("Configure GLINT_MEDIA_BASE_URL and GLINT_MEDIA_API_KEY");
const client = new MediaGatewayClient({ baseUrl, apiKey });
const type = readArg(args, "list");
if (type) {
  if (!["audio", "image", "video"].includes(type)) throw new Error("list must be audio, image or video");
  console.log(JSON.stringify(await client.models(type as "audio" | "image" | "video"), null, 2));
} else if (readArg(args, "voices")) console.log(JSON.stringify(await client.voices(readArg(args, "voices")!), null, 2));
else {
  const out = readArg(args, "out"); if (!out) throw new Error("Pass --out=<new local asset path>");
  if (fs.existsSync(out)) throw new Error("Asset output already exists; choose a new path");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  let id = readArg(args, "task");
  if (!id) {
    const model = readArg(args, "model"), prompt = readArg(args, "prompt");
    if (!model || !prompt) throw new Error("Pass --model and --prompt, or resume with --task");
    const paramsFile = readArg(args, "params");
    const params = paramsFile ? JSON.parse(fs.readFileSync(paramsFile, "utf8")) : {};
    id = await client.submit(model, prompt, params);
    fs.writeFileSync(`${out}.task.json`, JSON.stringify({ taskId: id, model, baseUrl }, null, 2), { flag: "wx" });
  }
  console.log(`[media] task=${id}; resume with --task=${id}; polling does not resubmit`);
  const task = await client.wait(id);
  const result = await downloadMediaResult(task, undefined, { publicDns: process.env.GLINT_MEDIA_PUBLIC_DNS === "1" });
  fs.writeFileSync(out, result.bytes, { flag: "wx" });
  fs.writeFileSync(`${out}.result.json`, JSON.stringify({ ...task, bytes: result.bytes.length, contentType: result.contentType }, null, 2));
  console.log(`[media] ${result.bytes.length} bytes (${result.contentType}) → ${out}`);
}
