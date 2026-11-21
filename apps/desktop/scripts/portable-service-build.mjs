import { join } from "node:path";

/**
 * Banner for node-target ESM bundles: esbuild emits ESM but bundled CJS deps
 * (and their code paths) still expect `require`, `__filename` and `__dirname`.
 * Shared verbatim by the packager and the bundled-entry regression tests so
 * tests exercise exactly what ships.
 */
export const esmNodeShim = `import { createRequire as __glintCreateRequire } from "node:module";\nimport { fileURLToPath as __glintFileURLToPath } from "node:url";\nconst require = __glintCreateRequire(import.meta.url);\nconst __filename = __glintFileURLToPath(import.meta.url);\nconst __dirname = __filename.slice(0, Math.max(__filename.lastIndexOf("/"), __filename.lastIndexOf("\\\\")));`;

/** Shared by the packager and the bundled-entry regression test. */
export function desktopServiceBuildOptions(repo, outfile) {
  return {
    entryPoints: [join(repo, "apps/web/server/desktop-service.mjs")], outfile,
    bundle: true, platform: "node", format: "esm", target: "node22",
    define: { "__GLINT_DESKTOP_BUNDLE__": "true" },
    alias: {
      "@glintai/session": join(repo, "packages/session/src/index.ts"),
      "@glintai/session/node": join(repo, "packages/session/src/node.ts"),
      "@glintai/scenescript": join(repo, "packages/scenescript/src/index.ts"),
      "@glintai/scenescript/project-container": join(repo, "packages/scenescript/src/project-container.ts"),
      "@glintai/scenescript/project-container-v2": join(repo, "packages/scenescript/src/project-container-v2.ts"),
      "@glintai/scenescript/auxiliary-documents": join(repo, "packages/scenescript/src/auxiliary-documents.ts"),
      "@glintai/scenescript/gen-canvas": join(repo, "packages/scenescript/src/gen-canvas.ts"),
      "@glintai/scenescript/migrate": join(repo, "packages/scenescript/src/migrate.ts"),
      "@glintai/scenescript/bundle": join(repo, "packages/scenescript/src/bundle.ts"),
      "@glintai/scenescript/chapter-bundle": join(repo, "packages/scenescript/src/chapter-bundle.ts"),
      "@glintai/scenescript/asset-invalidate": join(repo, "packages/scenescript/src/asset-invalidate.ts"),
      "@glintai/music": join(repo, "packages/music/src/index.ts"),
    },
    // jsdom resolves worker/support files relative to its installed package. It cannot
    // be flattened into one ESM file; portable-dependencies copies its runtime closure.
    external: ["@resvg/resvg-js", "jsdom"], logLevel: "warning",
    banner: { js: 'import { createRequire as __glintServiceRequire } from "node:module"; const require = __glintServiceRequire(import.meta.url);' },
  };
}

/** Kept separate and unmounted until desktop identity and filesystem boundaries are verified. */
export function portableChapterBuildOptions(repo, outfile) {
  return { ...desktopServiceBuildOptions(repo, outfile), entryPoints: [join(repo, "apps/web/server/portable-chapter-adapter.mjs")] };
}

export function localChapterToolBuildOptions(repo, outfile) {
  return { ...desktopServiceBuildOptions(repo, outfile), entryPoints: [join(repo, "apps/desktop/scripts/local-chapter-tool.mjs")] };
}
