import type { Plugin } from "vite";
import { buildThreeRuntime } from "../../studio/scripts/decoders";

/** Build and dev expose identical bytes, without adding Three to the entry chunk. */
export function threeRuntime(): Plugin {
  let pending: Promise<Uint8Array> | undefined;
  const bytes = () => (pending ??= buildThreeRuntime());
  return {
    name: "glint-three-runtime",
    async generateBundle() {
      this.emitFile({ type: "asset", fileName: "three.runtime.js", source: await bytes() });
    },
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if (request.url?.split("?")[0] !== "/three.runtime.js") return next();
        try {
          response.setHeader("Content-Type", "text/javascript; charset=utf-8");
          response.setHeader("X-Content-Type-Options", "nosniff");
          response.end(Buffer.from(await bytes()));
        } catch (error) {
          next(error);
        }
      });
    },
  };
}
