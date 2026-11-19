import { workspaceAssetSchema } from "@glintai/scenescript";

// Storage-only half of the project asset index. Kept apart from design-assets.ts, which
// parses design HTML, so project storage on the first screen does not load the editor DOM code.

/** Per-project recency list: files still live in the shared media root, but the project remembers its own picks. */
export const projectAssetsKey = (projectId: string) => `glint:project-assets.v1:${projectId}`;

export function readProjectAssetsStrict(projectId: string, storage: Pick<Storage, "getItem"> = localStorage) {
  const raw = storage.getItem(projectAssetsKey(projectId));
  if (raw === null) return [];
  try {
    if (raw.length > 128 * 1024) throw new Error();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length > 40) throw new Error();
    const assets = parsed.map(item => workspaceAssetSchema.parse(item));
    if (new Set(assets.map(item => item.name)).size !== assets.length) throw new Error();
    return assets;
  } catch { throw new Error("项目素材索引损坏；版本操作已停止，旧数据未覆盖。"); }
}
