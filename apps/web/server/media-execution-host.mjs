import fs from "node:fs";
import { createMediaExecution } from "./media-execution.mjs";
import { createMediaExecutionRoutes } from "./media-execution-routes.mjs";
import { createModelRegistryStore } from "./model-registry-store.mjs";

export function createMediaExecutionHost({
  jobs,
  settings,
  registryFile,
  registryStore,
  root,
  transport,
  download,
}) {
  const registry = registryStore ?? createModelRegistryStore(registryFile);
  // The media root (and its directory) is resolved on the first execution route
  // hit, not at server startup: a disabled or unsafe media library must stay
  // untouched until media execution is actually used.
  let service;
  const resolveService = () => {
    if (!service) {
      const mediaRoot = typeof root === "function" ? root() : root;
      fs.mkdirSync(mediaRoot, { recursive: true });
      service = createMediaExecution({
        root: mediaRoot,
        registryStore: registry,
        mediaSettings: settings,
        jobs,
        transport,
        download,
      });
    }
    return service;
  };
  return { registry, route: createMediaExecutionRoutes(resolveService) };
}
