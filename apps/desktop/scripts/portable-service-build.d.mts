import type { BuildOptions } from "esbuild";

/** Typed surface of portable-service-build.mjs for TypeScript importers. */
export const esmNodeShim: string;
export function desktopServiceBuildOptions(repo: string, outfile: string): BuildOptions;
export function portableChapterBuildOptions(repo: string, outfile: string): BuildOptions;
export function localChapterToolBuildOptions(repo: string, outfile: string): BuildOptions;
