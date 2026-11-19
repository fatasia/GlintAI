import fs from "node:fs/promises";
import { createReadStream, constants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { migrateDocumentToContainer, parseProjectContainer, type DocumentKind } from "@glintai/scenescript/project-container";

const MAX_JSON = 16 * 1024 * 1024, MAX_ASSETS = 2 * 1024 ** 3;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
type Asset = { path: string; sha256: string; bytes: number };
async function fileSha(file: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function assetReferences(value: unknown): string[] {
  const found = new Set<string>();
  function visit(item: unknown, key = "") {
    if (typeof item === "string") {
      if (!["src", "audioRef", "refs"].includes(key)) return;
      if (/\.(gltf|glb)$/i.test(item)) throw new Error("Bundle glTF dependencies before migrating this project");
      if (item.startsWith("assets/")) {
        if (item.includes("\\") || item.includes("\0") || item.includes(":") || item.split("/").some(p => !p || p === "." || p === "..")) throw new Error("Invalid managed asset path");
        found.add(item);
      } else if (["src", "audioRef"].includes(key) && item) throw new Error("Import media into assets/ before migrating this project");
    } else if (Array.isArray(item)) item.forEach(child => visit(child, key));
    else if (item && typeof item === "object") {
      if (["html", "three"].includes(String((item as { kind?: unknown }).kind))) throw new Error("Embedded HTML and Three resources require an explicit resource bundle");
      for (const [name, child] of Object.entries(item)) visit(child, name);
    }
  }
  visit(value); return [...found].sort();
}

async function publishManifest(out: string, manifest: unknown) {
  const temporary = path.join(out, `.migration-${randomUUID()}.tmp`);
  const handle = await fs.open(temporary, "wx");
  try {
    await handle.writeFile(JSON.stringify(manifest, null, 2)); await handle.sync();
  } catch (error) {
    await handle.close(); await fs.unlink(temporary); throw error;
  }
  await handle.close();
  try { await fs.link(temporary, path.join(out, "migration.json")); }
  finally { await fs.unlink(temporary); }
}

async function regularAsset(root: string, relative: string) {
  let current = root;
  const pieces = relative.split("/");
  for (let i = 0; i < pieces.length; i++) {
    current = path.join(current, pieces[i]!);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || (i === pieces.length - 1 ? !stat.isFile() : !stat.isDirectory())) throw new Error("Assets must be regular files inside the project directory");
  }
  return current;
}

async function copyAssets(root: string, out: string, refs: string[]): Promise<Asset[]> {
  const entries: Asset[] = []; let total = 0;
  for (const ref of refs) {
    const source = await regularAsset(root, ref), stat = await fs.stat(source);
    total += stat.size;
    if (total > MAX_ASSETS) throw new Error("Migration assets exceed 2 GiB");
    const target = path.join(out, ref); await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target, constants.COPYFILE_EXCL);
    // Both source and destination are checked after copying, before publication.
    const [originalHash, copiedHash] = await Promise.all([fileSha(source), fileSha(target)]);
    if ((await fs.stat(source)).size !== stat.size || (await fs.stat(target)).size !== stat.size || originalHash !== copiedHash) throw new Error("Asset changed during migration");
    entries.push({ path: ref, sha256: copiedHash, bytes: stat.size });
  }
  return entries;
}

/** A new import, not an edit of an existing project. No source files are rewritten. */
export async function migrateProjectDirectory(options: { source: string; out: string; kind: DocumentKind }) {
  if (!["scene-document", "timeline-document"].includes(options.kind)) throw new Error("Specify scene-document or timeline-document");
  if (!options.source || !options.out) throw new Error("Source and new output directory are required");
  const source = path.resolve(options.source), out = path.resolve(options.out);
  const stat = await fs.lstat(source);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_JSON) throw new Error("Source must be a regular JSON file no larger than 16 MiB");
  const bytes = await fs.readFile(source);
  if (bytes.length > MAX_JSON) throw new Error("Source exceeds 16 MiB");
  const original = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, ""));
  const migrated = await migrateDocumentToContainer(original, { kind: options.kind, projectId: `project-${randomUUID()}`, objectId: "document", versionId: "initial", actor: "cli", transactionId: `import-${randomUUID()}` });
  const refs = assetReferences(migrated.container.versions[0]!.payload);
  // Preflight every asset before creating an output directory.
  let total = 0;
  for (const ref of refs) { total += (await fs.stat(await regularAsset(path.dirname(source), ref))).size; if (total > MAX_ASSETS) throw new Error("Migration assets exceed 2 GiB"); }
  await fs.mkdir(out); // exclusive: even an empty existing directory is preserved
  await fs.writeFile(path.join(out, "original.json"), bytes, { flag: "wx" });
  const assets = await copyAssets(path.dirname(source), out, refs);
  const serialized = JSON.stringify(migrated.container, null, 2);
  await fs.writeFile(path.join(out, "project.json"), serialized, { flag: "wx" });
  const written = await fs.readFile(path.join(out, "project.json"));
  if (sha(written) !== sha(Buffer.from(serialized))) throw new Error("Container changed during migration");
  await parseProjectContainer(JSON.parse(written.toString("utf8")));
  if (sha(await fs.readFile(source)) !== sha(bytes) || sha(await fs.readFile(path.join(out, "original.json"))) !== sha(bytes)) throw new Error("Source or archive changed during migration");
  const manifest = { format: "glint-migration", version: 1, state: "complete", sourceSha256: sha(bytes), sourceBytes: bytes.length, original: "original.json", project: "project.json", projectSha256: sha(Buffer.from(serialized)), assets, diagnostics: migrated.diagnostics };
  await publishManifest(out, manifest);
  return manifest;
}

export async function runProjectMigration(args: string[]) {
  const values = new Map<string, string>();
  for (const arg of args) {
    const match = /^--(project|out|kind)=(.+)$/.exec(arg);
    if (!match || values.has(match[1]!)) throw new Error("project-migrate accepts --project= --out= --kind=scene-document|timeline-document");
    values.set(match[1]!, match[2]!);
  }
  const result = await migrateProjectDirectory({ source: values.get("project") ?? "", out: values.get("out") ?? "", kind: values.get("kind") as DocumentKind });
  console.log(JSON.stringify(result, null, 2)); return result;
}
