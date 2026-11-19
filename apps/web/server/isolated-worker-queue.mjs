// A separate admission budget for future isolated workers. This is not a
// process, filesystem, or network sandbox, and does not make Web rendering safe.
export function createIsolatedWorkerQueue({ concurrency = 1, maxQueued = 4 } = {}) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 ||
      !Number.isSafeInteger(maxQueued) || maxQueued < 0) {
    throw new RangeError("Invalid isolated worker queue limits");
  }
  const pending = [];
  const active = new Set();
  let closed = false;

  function abortError(message) {
    return Object.assign(new Error(message), { name: "AbortError" });
  }

  function detach(entry) {
    entry.signal?.removeEventListener("abort", entry.onAbort);
  }

  function finish(entry, succeeded, result) {
    detach(entry);
    active.delete(entry);
    pump();
    if (entry.controller.signal.aborted) entry.reject(abortError("Job cancelled"));
    else if (succeeded) entry.resolve(result);
    else entry.reject(result);
  }

  function pump() {
    while (!closed && active.size < concurrency && pending.length) {
      const entry = pending.shift();
      active.add(entry);
      // Begin asynchronously so synchronous exceptions share the same cleanup path.
      Promise.resolve().then(() => {
        if (entry.controller.signal.aborted) throw abortError("Job cancelled");
        return entry.task(entry.controller.signal);
      }).then(
        value => finish(entry, true, value),
        error => finish(entry, false, error),
      );
    }
  }

  function submit(task, { signal } = {}) {
    if (typeof task !== "function") return Promise.reject(new TypeError("Worker task must be a function"));
    if (closed) return Promise.reject(new Error("Isolated worker queue is closed"));
    if (signal?.aborted) return Promise.reject(abortError("Job cancelled"));
    if (active.size >= concurrency && pending.length >= maxQueued) {
      return Promise.reject(new Error("Isolated worker queue is full"));
    }
    return new Promise((resolve, reject) => {
      const entry = { task, signal, resolve, reject, controller: new AbortController() };
      entry.onAbort = () => {
        entry.controller.abort();
        const index = pending.indexOf(entry);
        if (index !== -1) {
          pending.splice(index, 1);
          detach(entry);
          reject(abortError("Job cancelled"));
        }
      };
      signal?.addEventListener("abort", entry.onAbort, { once: true });
      pending.push(entry);
      pump();
    });
  }

  function close() {
    if (closed) return;
    closed = true;
    for (const entry of pending.splice(0)) {
      detach(entry);
      entry.controller.abort();
      entry.reject(abortError("Isolated worker queue closed"));
    }
    for (const entry of active) entry.controller.abort();
  }

  return { submit, close, get running() { return active.size; }, get queued() { return pending.length; } };
}
