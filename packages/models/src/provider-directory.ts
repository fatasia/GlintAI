// Portions derived from OpenMotion (nexu-io/openmotion) shared/provider-registry.ts and provider-presets.json, Apache-2.0. Modifications: connection metadata only — no pricing, no keys, no referral links; execution adapters stay out of scope (M-02 owns real-service integration).

import { z } from "zod";

/**
 * 供应商连接目录：BYOK 添加模型时的预填元数据（label/baseUrl/密钥环境变量/官网）。
 * 刻意不含价目——Glint 的原则是“云模型由用户与其支付的价格一起添加”（见 builtin.ts）；
 * 也不含密钥本身。执行适配器（fal queue / Atlas prediction 等）不在本目录范围。
 */

const ProviderPreset = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  label: z.string().min(1).max(120),
  kind: z.enum(["media", "compatible"]),
  // HTTPS everywhere except loopback: local runtimes (Ollama) legitimately serve plain HTTP.
  baseUrl: z.string().url().refine(url => url.startsWith("https://") || url.startsWith("http://127.0.0.1"), "baseUrl 必须是 HTTPS（仅 127.0.0.1 允许 HTTP）"),
  /** 供应商控制台的密钥页；仅指路，不承载密钥。 */
  keyWebsite: z.string().url().optional(),
  keyEnvironment: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).optional(),
  docs: z.string().url().optional(),
  kinds: z.array(z.enum(["text", "image", "video", "audio", "speech"])).min(1).max(5),
});
export type ProviderPreset = z.infer<typeof ProviderPreset>;

const MEDIA = [
  { id: "fal", label: "fal.ai", kind: "media", baseUrl: "https://queue.fal.run", keyWebsite: "https://fal.ai/dashboard/keys", keyEnvironment: "FAL_KEY", kinds: ["image", "video", "audio"] },
  { id: "atlascloud", label: "Atlas Cloud", kind: "media", baseUrl: "https://api.atlascloud.ai", keyWebsite: "https://www.atlascloud.ai/console/api-keys", keyEnvironment: "ATLASCLOUD_API_KEY", kinds: ["image", "video", "audio"] },
  { id: "wavespeed", label: "WaveSpeedAI", kind: "media", baseUrl: "https://api.wavespeed.ai", keyWebsite: "https://wavespeed.ai/accesskey", keyEnvironment: "WAVESPEED_API_KEY", kinds: ["image", "video", "audio"] },
] as const satisfies readonly ProviderPreset[];

const COMPATIBLE = [
  { id: "openrouter", label: "OpenRouter", kind: "compatible", baseUrl: "https://openrouter.ai/api/v1", keyWebsite: "https://openrouter.ai/keys", keyEnvironment: "OPENROUTER_API_KEY", docs: "https://openrouter.ai/docs", kinds: ["text"] },
  { id: "siliconflow", label: "SiliconFlow", kind: "compatible", baseUrl: "https://api.siliconflow.cn/v1", keyWebsite: "https://cloud.siliconflow.cn/account/ak", keyEnvironment: "SILICONFLOW_API_KEY", docs: "https://docs.siliconflow.cn/", kinds: ["text", "image", "video"] },
  { id: "aihubmix", label: "AiHubMix", kind: "compatible", baseUrl: "https://aihubmix.com/v1", keyWebsite: "https://aihubmix.com", keyEnvironment: "AIHUBMIX_API_KEY", docs: "https://doc.aihubmix.com/", kinds: ["text", "image"] },
  { id: "deepseek", label: "DeepSeek", kind: "compatible", baseUrl: "https://api.deepseek.com/v1", keyWebsite: "https://platform.deepseek.com/api_keys", keyEnvironment: "DEEPSEEK_API_KEY", docs: "https://api-docs.deepseek.com/", kinds: ["text"] },
  { id: "moonshot", label: "Moonshot AI", kind: "compatible", baseUrl: "https://api.moonshot.cn/v1", keyWebsite: "https://platform.moonshot.cn/console/api-keys", keyEnvironment: "MOONSHOT_API_KEY", docs: "https://platform.moonshot.cn/docs", kinds: ["text"] },
  { id: "zhipu", label: "智谱 AI", kind: "compatible", baseUrl: "https://open.bigmodel.cn/api/paas/v4", keyWebsite: "https://open.bigmodel.cn/usercenter/apikeys", keyEnvironment: "ZHIPU_API_KEY", docs: "https://docs.bigmodel.cn/", kinds: ["text", "image", "video"] },
  { id: "ollama", label: "Ollama（本机）", kind: "compatible", baseUrl: "http://127.0.0.1:11434/v1", docs: "https://github.com/ollama/ollama/blob/main/docs/openai.md", kinds: ["text"] },
] as const satisfies readonly ProviderPreset[];

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [...MEDIA, ...COMPATIBLE];

export function providerPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find(preset => preset.id === id);
}
