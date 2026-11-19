import { retargetGltf } from "./gltf-retarget";

const usage = "Usage: tsx apps/studio/scripts/gltf-retarget-cli.ts --source=<source.gltf> --target=<target.gltf> --mapping=<mapping.json> --clip-index=<integer> --out=<new.gltf>\nMapping: [{\"source\":0,\"target\":1}, ...] using glTF node indices; map all joints. Only self-contained glTF 2.0, identical rest TRS and hierarchy, joint rotation/translation LINEAR/STEP. Translation is copied unchanged; no proportion scaling or pose correction.";
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") { console.log(usage); return; }
  const values = new Map<string, string>();
  for (const arg of args) {
    const m = /^--(source|target|mapping|clip-index|out)=(.+)$/.exec(arg);
    if (!m || values.has(m[1]!)) throw new Error(`Invalid or duplicate argument: ${arg}\n${usage}`);
    values.set(m[1]!, m[2]!);
  }
  if (values.size !== 5 || !/^\d+$/.test(values.get("clip-index")!) || !values.get("out")!.toLowerCase().endsWith(".gltf")) throw new Error(usage);
  await retargetGltf(values.get("source")!, values.get("target")!, values.get("mapping")!, Number(values.get("clip-index")), values.get("out")!);
  console.log(`Saved new glTF: ${values.get("out")}`);
}
main().catch(error => { console.error(`Retarget refused: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
