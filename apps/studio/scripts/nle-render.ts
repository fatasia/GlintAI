import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { renderMedia, selectComposition } from "@remotion/renderer";
import { parseNleProject, type NleProject } from "@glintai/scenescript";
import { RenderSession } from "./render-session";
import { encodingOptions } from "./encoding";

/** Local files referenced by an NLE project, copied into the render public dir. */
export function nleAssetNames(project: NleProject): string[] {
  const names = new Set<string>();
  for (const track of project.tracks) for (const clip of track.clips) {
    if (clip.kind === "video" || clip.kind === "image" || clip.kind === "audio") names.add(clip.src.slice("assets/".length));
  }
  return [...names];
}

export async function renderNle({ projectFile, assetsDir, out, encoding = "balanced", concurrency = 4 }: {
  projectFile: string; assetsDir: string; out: string; encoding?: string; concurrency?: number;
}): Promise<{ output: string; bytes: number; durationMs: number }> {
  const project = parseNleProject(JSON.parse(fs.readFileSync(projectFile, "utf8")));
  const sourceDir = path.resolve(assetsDir);
  const session = new RenderSession();
  try {
    const targetDir = path.join(session.publicDir, "assets");
    fs.mkdirSync(targetDir, { recursive: true });
    for (const name of nleAssetNames(project)) {
      const source = path.join(sourceDir, name);
      const stat = fs.lstatSync(source);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`NLE asset must be a regular file: ${name}`);
      if (stat.size > 512 * 1024 * 1024) throw new Error(`NLE asset exceeds 512 MB: ${name}`);
      fs.mkdirSync(path.dirname(path.join(targetDir, name)), { recursive: true });
      fs.copyFileSync(source, path.join(targetDir, name));
    }
    const { serveUrl, puppeteerInstance } = await session.acquire();
    const composition = await selectComposition({ serveUrl, id: "GlintNle", inputProps: { project }, puppeteerInstance });
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    await renderMedia({
      composition, serveUrl, inputProps: { project }, codec: "h264", pixelFormat: "yuv420p",
      ...encodingOptions(encoding), outputLocation: path.resolve(out), concurrency, puppeteerInstance,
    });
    return { output: path.resolve(out), bytes: fs.statSync(path.resolve(out)).size, durationMs: Math.round(composition.durationInFrames / composition.fps * 1000) };
  } finally { await session.dispose(); }
}
