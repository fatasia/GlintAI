import { createRegistry, type ModelRegistry } from "./registry";
import type { ModelEntryInput } from "./schema";

/**
 * Entries Glint can declare without knowing anyone's price: things that run on this
 * machine. Cloud models are added by the user (or a shared registry file) together
 * with the price they pay; nothing here pretends to know a provider's tariff.
 */
export const BUILTIN_MODELS: readonly ModelEntryInput[] = [
  { id: "windows-sapi", name: "Windows 系统语音", provider: "本机", kind: "speech", capabilities: ["text-to-speech"], pricing: { basis: "free-local" }, adapter: { type: "local-process" }, source: "builtin", notes: "音质一般，适合试听与粗剪" },
  { id: "qwen-local-tts", name: "Qwen 本地语音", provider: "本机", kind: "speech", capabilities: ["text-to-speech", "voice-clone"], pricing: { basis: "free-local" }, adapter: { type: "local-process" }, source: "builtin", notes: "需要本机已部署模型" },
];

export function builtinRegistry(): ModelRegistry {
  return createRegistry(BUILTIN_MODELS);
}
