import path from "node:path";
import { randomUUID } from "node:crypto";
import { executionStore, recordTable, requireExecution, safeId } from "./media-execution-store.mjs";
import { executionInput, estimateExecution } from "./media-execution-input.mjs";
function validate(value) {
  recordTable(value, "quotes", 2000);
  recordTable(value, "attempts", 2000);
  for (const row of value.quotes)
    requireExecution(
      safeId(row.id) &&
        /^[a-f0-9]{64}$/.test(row.inputDigest) &&
        Number.isSafeInteger(row.units) &&
        row.units >= 0 &&
        row.unit === "CNY" &&
        Number.isFinite(row.expiresAt),
      "invalid-quote",
    );
  for (const row of value.attempts)
    requireExecution(
      safeId(row.requestId) &&
        safeId(row.quoteId) &&
        ["approved", "dispatched"].includes(row.state) &&
        Number.isSafeInteger(row.capUnits),
      "invalid-attempt",
    );
  requireExecution(
    new Set(value.quotes.map((row) => row.id)).size === value.quotes.length &&
      new Set(value.attempts.map((row) => row.requestId)).size === value.attempts.length,
    "duplicate-record",
  );
  return value;
}
class MediaQuotes {
  constructor({ root, bindings, now = Date.now }) {
    this.bindings = bindings;
    this.now = now;
    this.store = executionStore(
      path.join(root, "media-execution-associations.json"),
      { version: 1, quotes: [], attempts: [] },
      validate,
    );
  }
  async quote(input) {
    const { value, inputDigest } = executionInput(input),
      bound = await this.bindings.resolve(value.bindingId);
    const price = estimateExecution(bound, value);
    const record = {
      id: randomUUID(),
      bindingId: value.bindingId,
      bindingVersion: bound.version,
      inputDigest,
      ...price,
      expiresAt: this.now() + 300000,
      createdAt: this.now(),
    };
    await this.store.update((state) => {
      state.quotes.push(record);
    });
    return record;
  }
  async approve(input) {
    requireExecution(
      input &&
        input.confirmed === true &&
        safeId(input.quoteId) &&
        safeId(input.requestId) &&
        Number.isFinite(input.capCny) &&
        input.capCny >= 0 &&
        input.capCny <= 1000000,
      "confirmation-required",
    );
    const capUnits = Math.floor(input.capCny * 10000);
    return this.store.update((state) => {
      const quote = state.quotes.find((row) => row.id === input.quoteId);
      requireExecution(quote && quote.expiresAt > this.now(), "quote-expired", 409);
      const previous = state.attempts.find((row) => row.requestId === input.requestId);
      if (previous) {
        requireExecution(
          previous.quoteId === quote.id && previous.capUnits === capUnits,
          "request-conflict",
          409,
        );
        return previous;
      }
      requireExecution(
        !state.attempts.some((row) => row.quoteId === quote.id),
        "quote-consumed",
        409,
      );
      const reserved = state.attempts.reduce(
        (sum, row) => sum + state.quotes.find((item) => item.id === row.quoteId).units,
        0,
      );
      requireExecution(reserved + quote.units <= capUnits, "over-budget", 409);
      const attempt = {
        requestId: input.requestId,
        quoteId: quote.id,
        state: "approved",
        capUnits,
        approvedAt: this.now(),
        actor: "local-user",
      };
      state.attempts.push(attempt);
      return attempt;
    });
  }
  async consume(input, adapter) {
    const { value, inputDigest } = executionInput(input),
      bound = await this.bindings.resolve(value.bindingId);
    requireExecution(
      !adapter || bound.entry.adapter.type === adapter,
      "adapter-route-mismatch",
      409,
    );
    return this.store.update((state) => {
      const attempt = state.attempts.find((row) => row.requestId === input.requestId);
      const quote = state.quotes.find((row) => row.id === input.quoteId);
      requireExecution(attempt && quote && attempt.quoteId === quote.id, "approval-required", 409);
      requireExecution(attempt.state === "approved", "submission-unconfirmed", 409);
      requireExecution(
        quote.expiresAt > this.now() &&
          quote.inputDigest === inputDigest &&
          quote.bindingVersion === bound.version,
        "quote-changed",
        409,
      );
      estimateExecution(bound, value);
      attempt.state = "dispatched";
      attempt.dispatchedAt = this.now();
      return { quoteId: quote.id, requestId: attempt.requestId, bindingVersion: bound.version };
    });
  }
  async receipt(requestId) {
    requireExecution(safeId(requestId), "invalid-request");
    const state = await this.store.read(),
      attempt = state.attempts.find((row) => row.requestId === requestId);
    requireExecution(attempt, "unknown-request", 404);
    const quote = state.quotes.find((row) => row.id === attempt.quoteId);
    return {
      attempt,
      quote,
      observed: { amount: null, unit: null, source: "unknown" },
      budgetMeaning: "local-estimate-reservation-not-provider-cap",
    };
  }
}
export function createMediaQuoteStore(options) {
  return new MediaQuotes(options);
}
