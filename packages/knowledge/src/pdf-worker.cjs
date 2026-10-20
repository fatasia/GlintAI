const { parentPort, workerData } = require("node:worker_threads");
// PDF.js must receive an unpooled, zero-offset typed array. A pooled Buffer
// in worker threads can expose unrelated bytes through its backing ArrayBuffer.
require("pdf-parse/lib/pdf-parse.js")(Uint8Array.from(workerData)).then(
  (result) => parentPort.postMessage({ text: result.text }),
  (error) => parentPort.postMessage({ error: error.message }),
);
