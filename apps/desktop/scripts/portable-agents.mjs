import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { build } from "esbuild";

const ADAPTERS = [
  ["claude", "@agentclientprotocol/claude-agent-acp"],
  ["codex", "@agentclientprotocol/codex-acp"],
];

/** Keep adapter programs separate from the service and from the user's own CLI. */
export async function buildDesktopAgentAdapters(repo, destination) {
  mkdirSync(destination, { recursive: true });
  const require = createRequire(join(repo, "apps/web/package.json"));
  for (const [name, packageName] of ADAPTERS) {
    const manifest = require.resolve(`${packageName}/package.json`);
    const packageJson = JSON.parse(readFileSync(manifest, "utf8"));
    const entry = typeof packageJson.bin === "string" ? packageJson.bin : Object.values(packageJson.bin)[0];
    await build({ entryPoints: [join(dirname(manifest), entry)], outfile: join(destination, `${name}.mjs`),
      bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "warning",
      external: ["@anthropic-ai/claude-agent-sdk", "@openai/codex"],
      banner: { js: 'import { createRequire as __glintRequire } from "node:module"; const require = __glintRequire(import.meta.url);' } });
    cpSync(join(dirname(manifest), "LICENSE"), join(destination, `${name}.LICENSE`));
    if (name === "claude") {
      // The Anthropic SDK keeps its own license terms: bundle it only when the
      // build machine already provides it, never fetch or vendor it here.
      const adapterRequire = createRequire(manifest);
      let sdkRoot;
      try { sdkRoot = dirname(adapterRequire.resolve("@anthropic-ai/claude-agent-sdk")); }
      catch { console.warn(`[portable-agents] @anthropic-ai/claude-agent-sdk not installed; the ${name} adapter ships without it and must be installed on the user machine.`); continue; }
      const target = join(destination, "node_modules", "@anthropic-ai", "claude-agent-sdk");
      if (existsSync(target)) throw new Error("Agent SDK destination already exists");
      cpSync(sdkRoot, target, { recursive: true, dereference: true });
    }
  }
}
