import { MediaGatewayClient, downloadMediaResult } from "@glintai/media";
/** Use model-specific parameters explicitly; this gateway is not a Suno official API. */
export async function generateGatewayMusic(config: { baseUrl: string; apiKey: string; model: string; prompt: string; params?: Record<string, unknown>; publicDns?: boolean }, signal = AbortSignal.timeout(600000)) {
  const client = new MediaGatewayClient(config);
  const id = await client.submit(config.model, config.prompt, config.params ?? {}, signal);
  const task = await client.wait(id, { signal });
  const result = await downloadMediaResult(task, signal, { publicDns: config.publicDns });
  if (!["audio/mpeg", "audio/wav", "audio/x-wav"].includes(result.contentType)) throw new Error("Gateway music returned a non-audio asset");
  return { audio: result.bytes, extension: result.contentType === "audio/mpeg" ? "mp3" : "wav", taskId: id };
}
