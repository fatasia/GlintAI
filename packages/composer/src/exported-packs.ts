import type { SceneScriptProject } from "@glintai/scenescript";
import { parseImportedPack, type ImportedCreationPack } from "./imported-packs";

export interface CreationPackMetadata {
  id: string;
  title: string;
  description: string;
  author: string;
  license: string;
  packVersion: string;
  tags?: string[];
}

/** Export only what the portable importer accepts; never silently discard media. */
export function makeCreationPack(project: SceneScriptProject, metadata: CreationPackMetadata): ImportedCreationPack {
  return parseImportedPack({
    format: "glint-creation-pack",
    version: 1,
    id: metadata.id,
    title: metadata.title,
    description: metadata.description,
    author: metadata.author,
    license: metadata.license,
    packVersion: metadata.packVersion,
    tags: metadata.tags === undefined ? [] : metadata.tags,
    permissions: [],
    // Keep the recipe's prior origin; materialization supplies the new origin pin.
    project,
  });
}
