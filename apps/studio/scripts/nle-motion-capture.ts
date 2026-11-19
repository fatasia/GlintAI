import { createMotionAccumulator } from "./nle-motion-pixels";
export interface MotionCaptureHost {
  __glintMotionStart(width: number, height: number, samples: number): void;
  __glintMotionSample(pngBase64: string): Promise<void>;
  __glintMotionFinish(): Promise<string>;
  __glintMotionDispose(): void;
}
/** Screenshot pixels, not a replacement scene renderer. No DOM or media clock is changed. */
export function installMotionCapture(host: MotionCaptureHost) {
  let accumulator: ReturnType<typeof createMotionAccumulator> | undefined, canvas: OffscreenCanvas | undefined;
  const dispose = () => { accumulator?.dispose(); accumulator = undefined; canvas = undefined; };
  host.__glintMotionDispose = dispose;
  host.__glintMotionStart = (width, height, samples) => { dispose(); accumulator = createMotionAccumulator(width, height, samples); canvas = new OffscreenCanvas(width, height); };
  host.__glintMotionSample = async encoded => {
    if (!accumulator || !canvas || encoded.length > 22369624) throw new Error("Invalid or oversized motion screenshot");
    const binary = atob(encoded), bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    try {
      if (bitmap.width !== canvas.width || bitmap.height !== canvas.height) throw new Error("Motion screenshot dimensions mismatch");
      const context = canvas.getContext("2d", { willReadFrequently: true })!;
      context.clearRect(0, 0, canvas.width, canvas.height); context.drawImage(bitmap, 0, 0);
      accumulator.add(context.getImageData(0, 0, canvas.width, canvas.height).data);
    } finally { bitmap.close(); }
  };
  host.__glintMotionFinish = async () => {
    if (!accumulator || !canvas) throw new Error("Motion frame not started");
    try {
      const context = canvas.getContext("2d")!, output = accumulator.finish();
      const data = context.createImageData(canvas.width, canvas.height); data.data.set(output); context.putImageData(data, 0, 0);
      const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
      let binary = ""; for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      return btoa(binary);
    } finally { dispose(); }
  };
}
