export function requestLifetime(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
  label: string,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("Request deadline exceeded", "TimeoutError")), timeoutMs);
  const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
  return {
    signal,
    dispose: () => clearTimeout(timer),
    error(error: unknown): never {
      if (callerSignal?.aborted) throw callerSignal.reason;
      if (controller.signal.aborted) {
        throw new Error(`${label} timed out after ${timeoutMs}ms. Increase timeoutMs or check network/proxy.`, { cause: error });
      }
      throw error;
    },
  };
}
