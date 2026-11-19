/** Validate before sending; an omitted budget preserves provider defaults. */
export function outputBudget(value: number | undefined): number | undefined {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new Error("maxOutputTokens must be a positive safe integer");
  }
  return value;
}
