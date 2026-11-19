import { z } from "zod";

/**
 * A model entry is data, not code: the generation UI, the quote and the selector
 * all read the same declaration. Prices are never guessed: an entry whose price the
 * user has not declared says `unknown`, and the budget guard treats it as such.
 */

export const MODEL_ID = /^[a-z0-9]+(?:[a-z0-9._-]*[a-z0-9])?$/;

export const ModelKind = z.enum(["image", "video", "audio", "speech", "llm", "3d", "upscale"]);
export type ModelKind = z.infer<typeof ModelKind>;

/** Capability tags are open-ended strings so a new model can declare a new one without a code change. */
export const Capability = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(48);

const amount = z.number().finite().min(0).max(100_000);

export const Pricing = z.discriminatedUnion("basis", [
  z.object({ basis: z.literal("free-local") }),
  z.object({ basis: z.literal("per-call"), amountCny: amount }),
  z.object({ basis: z.literal("per-image"), amountCny: amount }),
  z.object({ basis: z.literal("per-second"), amountCny: amount }),
  z.object({ basis: z.literal("per-1k-chars"), amountCny: amount }),
  z.object({ basis: z.literal("unknown") }),
]);
export type Pricing = z.infer<typeof Pricing>;

export const AdapterType = z.enum(["openai-images", "skills-gateway", "openai-compatible", "fal", "replicate", "openrouter", "comfyui", "local-process"]);
export type AdapterType = z.infer<typeof AdapterType>;

export const ModelEntry = z.object({
  id: z.string().min(1).max(80).regex(MODEL_ID),
  name: z.string().min(1).max(120),
  provider: z.string().min(1).max(80),
  kind: ModelKind,
  capabilities: z.array(Capability).max(32),
  pricing: Pricing,
  limits: z.object({
    maxDurationSec: z.number().positive().max(3600).optional(),
    maxReferenceImages: z.number().int().min(0).max(32).optional(),
    aspects: z.array(z.enum(["16:9", "9:16", "1:1"])).max(3).optional(),
    resolutions: z.array(z.string().max(16)).max(12).optional(),
  }).default({}),
  adapter: z.object({
    type: AdapterType,
    /** The model name sent to the remote service. */
    model: z.string().min(1).max(200).optional(),
    /** For ComfyUI: the user-imported workflow this entry runs. */
    workflow: z.string().min(1).max(200).optional(),
  }),
  source: z.enum(["builtin", "user"]).default("user"),
  notes: z.string().max(400).optional(),
}).superRefine((entry, ctx) => {
  if (entry.adapter.type === "comfyui" && !entry.adapter.workflow) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["adapter", "workflow"], message: "a comfyui entry needs the workflow it runs" });
  if (entry.adapter.type !== "comfyui" && entry.adapter.type !== "local-process" && !entry.adapter.model) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["adapter", "model"], message: "a remote entry needs the model name to send" });
  if (entry.pricing.basis === "free-local" && !["comfyui", "local-process"].includes(entry.adapter.type)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["pricing"], message: "free-local pricing is only valid for a local adapter" });
  if (new Set(entry.capabilities).size !== entry.capabilities.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["capabilities"], message: "duplicate capability" });
});
export type ModelEntry = z.infer<typeof ModelEntry>;
export type ModelEntryInput = z.input<typeof ModelEntry>;
