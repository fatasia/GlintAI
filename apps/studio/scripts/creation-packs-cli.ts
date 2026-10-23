import fs from "node:fs";
import path from "node:path";
import { instantiateCreationPack, listCreationPacks } from "@glintai/composer/creation-packs";
import { readArg } from "./glint-runtime";
import { IMPORTED_PACK_MAX_BYTES, materializeImportedPack, parseImportedPack } from "@glintai/composer/imported-packs";
import { makeCreationPack } from "@glintai/composer/exported-packs";
import { parseProject } from "@glintai/scenescript";

/** Same data-only application path as the Web library. No package code is executed. */
export function runCreationPacks(args: string[]) {
  const exportProject = readArg(args, "export-project");
  if (exportProject) {
    if (readArg(args, "use") || readArg(args, "source") || readArg(args, "params")) throw new Error("Export a project separately from pack application");
    const out = readArg(args, "out"), author = readArg(args, "author"), license = readArg(args, "license");
    if (!out || !author || !license || !args.includes("--confirm-rights")) throw new Error("Pack export requires --out= --author= --license= --confirm-rights after checking private content");
    const file = path.resolve(exportProject);
    if (!fs.statSync(file).isFile() || fs.statSync(file).size > IMPORTED_PACK_MAX_BYTES) throw new Error("Project must be a local JSON file no larger than 128 KiB");
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const project = parseProject(raw);
    const pack = makeCreationPack(raw, { id: readArg(args, "id") ?? `creation-${globalThis.crypto.randomUUID()}`,
      title: project.title, description: `${project.title} 的可编辑配方`, author, license, packVersion: readArg(args, "version") ?? "1.0.0" });
    const output = path.resolve(out);
    fs.writeFileSync(output, JSON.stringify(pack, null, 2), { flag: "wx" });
    console.log(JSON.stringify({ output, pack: { id: pack.id, version: pack.packVersion }, network: false, privateNotesRemoved: true }, null, 2));
    return { output, exportedPack: pack };
  }
  const use = readArg(args, "use"), source = readArg(args, "source");
  if (use && source) throw new Error("Choose a built-in --use or a data-pack --source, not both");
  if (!use && !source) {
    const packs = listCreationPacks(readArg(args, "query") ?? "");
    console.log(JSON.stringify({ packs }, null, 2)); return { packs };
  }
  const out = readArg(args, "out");
  if (!out) throw new Error("packs --use requires --out=<new-project.json>");
  const output = path.resolve(out);
  if (fs.existsSync(output)) throw new Error("Output already exists; choose a new file. No project was overwritten.");
  const params = readArg(args, "params");
  let values: Record<string, string> = {};
  if (params) {
    const file = path.resolve(params);
    if (!fs.statSync(file).isFile() || fs.statSync(file).size > 32_000) throw new Error("Pack input JSON must be a file no larger than 32 KB");
    values = JSON.parse(fs.readFileSync(file, "utf8"));
  }
  if (source && params) throw new Error("Imported data packs do not accept template params");
  let instance;
  if (source) {
    const file = path.resolve(source);
    if (!fs.statSync(file).isFile() || fs.statSync(file).size > IMPORTED_PACK_MAX_BYTES) throw new Error("Data pack must be a local JSON file no larger than 128 KiB");
    instance = materializeImportedPack(parseImportedPack(JSON.parse(fs.readFileSync(file, "utf8"))));
  } else instance = instantiateCreationPack(use!, values);
  // A single exclusive file write; an interrupted write is removable, never overwrites user work.
  let fd: number | undefined;
  try {
    fd = fs.openSync(output, "wx");
    fs.writeFileSync(fd, JSON.stringify(instance.project, null, 2)); fs.fsyncSync(fd);
  } finally { if (fd !== undefined) fs.closeSync(fd); }
  console.log(JSON.stringify({ output, projectId: instance.project.id, pack: instance.pack, network: false, paidCalls: 0 }, null, 2));
  return { output, ...instance };
}
