export type CanvasViewport = { x: number; y: number; zoom: number };
export function parseCanvasViewport(raw: string | null): CanvasViewport | undefined {
  if (raw === null) return;
  const value = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    ![value.x, value.y, value.zoom].every(n => typeof n === "number" && Number.isFinite(n)) ||
    Math.abs(value.x) > 1_000_000 || Math.abs(value.y) > 1_000_000 || value.zoom < 0.1 || value.zoom > 2.5)
    throw new Error("画布视口记录损坏；原记录已保留。");
  return { x: value.x, y: value.y, zoom: value.zoom };
}
