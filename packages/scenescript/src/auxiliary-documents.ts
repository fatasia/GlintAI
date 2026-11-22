import { z } from "zod";

const id = z.string().min(1).max(128);
const title = z.string().trim().min(1).max(500);
const timestamp = z.number().finite().nonnegative();
export const ScriptDocument = z
  .object({
    id,
    title,
    kind: z.enum(["script", "screenplay", "outline", "narration"]),
    content: z.string().max(4 * 1024 * 1024),
    updatedAt: timestamp,
  })
  .strict();
const annotation = z
  .object({
    id,
    x: z.number().min(0).max(100),
    y: z.number().min(0).max(100),
    text: z.string().max(2000),
    nodeId: z
      .string()
      .regex(/^[\w-]{1,100}$/)
      .optional(),
    createdAt: timestamp,
  })
  .strict();
// S-03 page transitions: same shape the web editor authors (120–1200ms integer range).
const pageTransition = z
  .object({
    type: z.enum(["none", "fade", "push", "wipe", "zoom"]),
    durationMs: z.number().int().min(120).max(1200),
  })
  .strict();
const page = z
  .object({
    id,
    title,
    html: z.string().max(1024 * 1024),
    notes: z.string().optional(),
    annotations: z.array(annotation).max(200).optional(),
    transition: pageTransition.optional(),
    stepReveal: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      new Set(value.annotations?.map((mark) => mark.id)).size !== (value.annotations?.length ?? 0)
    )
      ctx.addIssue({ code: "custom", message: "Duplicate annotation identity" });
  });
export const DesignDocument = z
  .object({
    id,
    title,
    kind: z.enum(["page", "prototype", "slides"]),
    pages: z.array(page).min(1).max(100),
    activePageId: id,
    updatedAt: timestamp,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      new Set(value.pages.map((item) => item.id)).size !== value.pages.length ||
      !value.pages.some((item) => item.id === value.activePageId)
    )
      ctx.addIssue({ code: "custom", message: "Duplicate or unavailable design page" });
  });
export type ScriptDocument = z.infer<typeof ScriptDocument>;
export type DesignDocument = z.infer<typeof DesignDocument>;
