import type { SceneScriptProject } from "@glintai/scenescript";
export type BoardAsset = { name: string; url: string; kind: "image" | "video"; usedBy: string[] };
/** Only service-owned image/video references; no external URL is fetched by the board. */
export function boardAssets(project: SceneScriptProject, registered: {name:string;url:string}[]): BoardAsset[] {
  const assets = new Map<string,BoardAsset>();
  const accept = (raw: string, sceneId?: string) => {
    const match = /^(?:assets\/|\/(?:api\/media\/assets|assets)\/)([a-zA-Z0-9_-]{1,100}\.(png|jpg|webp|mp4))$/.exec(raw);
    if (!match) return;
    const name = match[1]!;
    const value = assets.get(name) ?? {name,url:`/api/media/assets/${name}`,kind:match[2] === "mp4" ? "video" as const : "image" as const,usedBy:[]};
    if (sceneId && !value.usedBy.includes(sceneId)) value.usedBy.push(sceneId);
    assets.set(name,value);
  };
  for (const asset of registered) accept(asset.url);
  for (const scene of project.scenes) if (scene.kind === "image" || scene.kind === "video") accept(scene.src,scene.id);
  return [...assets.values()];
}
