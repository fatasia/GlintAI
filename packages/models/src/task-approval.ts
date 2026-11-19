import { z } from "zod";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const TaskApproval = z
  .object({
    format: z.literal("glint-task-approval"),
    version: z.literal(1),
    planDigest: hash,
    inputDigest: hash,
    projectDigest: hash,
    stepsDigest: hash,
    quoteDigest: hash,
    confirmedAt: z.string().datetime(),
  })
  .strict();
export type TaskApproval = z.infer<typeof TaskApproval>;
export interface ApprovalBinding {
  planDigest: string;
  inputDigest: string;
  projectDigest: string;
  stepsDigest: string;
  quoteDigest: string;
}
/** Validates identity, not authorization to arbitrary effects. The adapter must rebuild effects. */
export function requireTaskApproval(value: unknown, binding: ApprovalBinding): TaskApproval {
  const approval = TaskApproval.parse(value);
  for (const key of Object.keys(binding) as (keyof ApprovalBinding)[])
    if (approval[key] !== binding[key]) throw new Error("Approval no longer matches " + key);
  return approval;
}
