import fs from "node:fs";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { Matrix4, Quaternion, Vector3 } from "three";

const LIMIT = 64 * 1024 * 1024;
const EPS = 1e-5;
type Doc = Record<string, any>;
function reject(message: string): never { throw new Error(message); }
function array(value: unknown, label: string): any[] {
  if (!Array.isArray(value)) reject(`${label} must be an array`);
  return value;
}
function index(value: unknown, list: any[], label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) >= list.length) reject(`Invalid ${label}`);
  return value as number;
}
function noExtensions(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (Object.prototype.hasOwnProperty.call(value, "extensions") || Object.prototype.hasOwnProperty.call(value, "extensionsUsed") || Object.prototype.hasOwnProperty.call(value, "extensionsRequired")) reject("glTF extensions are unsupported");
  for (const v of Object.values(value)) noExtensions(v);
}
function bufferData(uri: unknown, length: unknown): Buffer {
  if (typeof uri !== "string" || !/^data:application\/(?:octet-stream|gltf-buffer);base64,[A-Za-z0-9+/]*={0,2}$/.test(uri)) reject("Only embedded base64 glTF buffers are supported");
  const bytes = Buffer.from(uri.slice(uri.indexOf(",") + 1), "base64");
  if (bytes.length > LIMIT || !Number.isInteger(length) || length !== bytes.length) reject("Invalid embedded buffer length");
  return bytes;
}
function readDocument(file: string): { doc: Doc; bytes: Buffer[]; text: string } {
  if (!file.toLowerCase().endsWith(".gltf")) reject("Only self-contained .gltf files are supported, not GLB or other formats");
  if (fs.statSync(file).size > LIMIT) reject("File exceeds 64 MiB");
  const content = fs.readFileSync(file); if (content.length > LIMIT) reject("File exceeds 64 MiB");
  let doc: Doc; try { doc = JSON.parse(content.toString("utf8")); } catch { return reject("Invalid glTF JSON"); }
  if (!doc || typeof doc !== "object" || Array.isArray(doc) || doc.asset?.version !== "2.0" || doc.asset?.minVersion) reject("Only glTF 2.0 is supported");
  noExtensions(doc);
  if (doc.images?.length) reject("Images are unsupported in this restricted tool");
  const bytes = array(doc.buffers, "buffers").map(b => bufferData(b?.uri, b?.byteLength));
  if (bytes.reduce((n, b) => n + b.length, 0) > LIMIT) reject("Embedded buffers exceed 64 MiB");
  return { doc, bytes, text: content.toString("utf8") };
}
function pose(node: Doc): number[][] {
  if (node.matrix !== undefined) reject("Matrix-authored nodes are unsupported; export TRS");
  const read = (value: unknown, fallback: number[], label: string) => {
    const v = value === undefined ? fallback : value;
    if (!Array.isArray(v) || v.length !== fallback.length || v.some(x => typeof x !== "number" || !Number.isFinite(x))) reject(`Invalid ${label}`);
    return v as number[];
  };
  const t = read(node.translation, [0, 0, 0], "translation"), q = read(node.rotation, [0, 0, 0, 1], "rotation"), s = read(node.scale, [1, 1, 1], "scale");
  if (Math.abs(Math.hypot(...q) - 1) > EPS || s.some(x => Math.abs(x - 1) > EPS)) reject("Rest rotations must be normalized and scale must be unit");
  return [t, q, s];
}
function skeleton(doc: Doc) {
  const nodes = array(doc.nodes, "nodes"), skins = array(doc.skins, "skins");
  if (skins.length !== 1) reject("Exactly one skin is required");
  const joints = array(skins[0]?.joints, "joints").map(j => index(j, nodes, "joint"));
  if (!joints.length || new Set(joints).size !== joints.length) reject("Skin joints must be nonempty and unique");
  const names = new Set<string>();
  for (const n of nodes) {
    if (n?.name !== undefined) {
      if (typeof n.name !== "string" || !/^[A-Za-z0-9_-]+$/.test(n.name) || names.has(n.name)) reject("Node names must be unique and use letters, digits, underscore or hyphen");
      names.add(n.name);
    }
  }
  const parents = new Map<number, number>();
  nodes.forEach((node, parent) => {
    if (!node || typeof node !== "object") reject("Invalid node");
    for (const raw of node.children === undefined ? [] : array(node.children, "children")) {
      const child = index(raw, nodes, "child"); if (parents.has(child) || child === parent) reject("Nodes must form a tree"); parents.set(child, parent);
    }
  });
  const set = new Set<number>(joints);
  for (const j of joints) {
    if (typeof nodes[j].name !== "string") reject("Every joint needs a unique name");
    pose(nodes[j]);
    if (parents.has(j) && !set.has(parents.get(j)!)) reject("Joint ancestors must be mapped joints; non-joint ancestors are unsupported");
    const visited = new Set<number>(); let cur: number | undefined = j;
    while (cur !== undefined) { if (visited.has(cur)) reject("Cycle in skeleton"); visited.add(cur); cur = parents.get(cur); }
  }
  const scenes = array(doc.scenes, "scenes"); const scene = scenes[index(doc.scene ?? 0, scenes, "scene")];
  const roots = array(scene?.nodes, "scene nodes").map(n => index(n, nodes, "scene root"));
  for (const j of joints) if (!parents.has(j) && !roots.includes(j)) reject("Joint root must be in the default scene");
  return { nodes, joints, parents };
}
function samePose(a: Doc, b: Doc): boolean {
  const x = pose(a), y = pose(b);
  return x.every((v, i) => v.every((n, j) => Math.abs(n - y[i]![j]!) <= EPS) || (i === 1 && v.every((n, j) => Math.abs(n + y[i]![j]!) <= EPS)));
}
function accessor(doc: Doc, buffers: Buffer[], id: unknown, type: "SCALAR" | "VEC3" | "VEC4" | "MAT4"): number[] {
  const accessors = array(doc.accessors, "accessors"), a = accessors[index(id, accessors, "accessor")];
  if (!a || a.componentType !== 5126 || a.type !== type || a.normalized || a.sparse || !Number.isInteger(a.count) || a.count < 1 || a.count > 1000000) reject(`Unsupported ${type} animation accessor`);
  const views = array(doc.bufferViews, "bufferViews"), v = views[index(a.bufferView, views, "bufferView")];
  if (!v || v.byteStride !== undefined || v.target !== undefined) reject("Animation buffer views must be tightly packed");
  const bytes = buffers[index(v.buffer, buffers, "buffer")]!;
  const start = (v.byteOffset ?? 0) + (a.byteOffset ?? 0), size = a.count * ({ SCALAR: 4, VEC3: 12, VEC4: 16, MAT4: 64 }[type]);
  if (![v.byteOffset ?? 0, a.byteOffset ?? 0, v.byteLength].every(Number.isSafeInteger) || (v.byteOffset ?? 0) < 0 || (a.byteOffset ?? 0) < 0 || v.byteLength < 0 || start % 4 || (a.byteOffset ?? 0) + size > v.byteLength || start + size > bytes.length) reject("Animation accessor is out of bounds");
  const values = Array.from({ length: size / 4 }, (_, i) => bytes.readFloatLE(start + i * 4));
  if (values.some(x => !Number.isFinite(x))) reject("Animation contains non-finite values");
  return values;
}
export async function retargetGltf(sourceFile: string, targetFile: string, mappingFile: string, clipIndex: number, outputFile: string): Promise<void> {
  const source = readDocument(sourceFile), target = readDocument(targetFile);
  if (fs.statSync(mappingFile).size > 1024 * 1024) reject("Mapping exceeds 1 MiB");
  const mappingBytes = fs.readFileSync(mappingFile); if (mappingBytes.length > 1024 * 1024) reject("Mapping exceeds 1 MiB");
  let mapping: any; try { mapping = JSON.parse(mappingBytes.toString("utf8")); } catch { return reject("Invalid mapping JSON"); }
  if (!Array.isArray(mapping) || !mapping.length || mapping.some(x => !x || typeof x !== "object" || Array.isArray(x) || Object.keys(x).sort().join(",") !== "source,target" || !Number.isInteger(x.source) || !Number.isInteger(x.target))) reject("Mapping must be an array of {source, target} node indices");
  const a = skeleton(source.doc), b = skeleton(target.doc), pairs = new Map<number, number>();
  for (const rig of [a, b]) {
    const meshes = rig.nodes.filter(n => n.skin !== undefined);
    if (meshes.length !== 1 || meshes[0].skin !== 0 || meshes[0].mesh === undefined) reject("Exactly one skinned mesh node is required");
    for (let i = 0; i < rig.nodes.length; i++) if (!rig.joints.includes(i)) {
      const p = pose(rig.nodes[i]);
      if (p[0]!.some(x => Math.abs(x) > EPS) || p[1]!.slice(0, 3).some(x => Math.abs(x) > EPS) || Math.abs(Math.abs(p[1]![3]!) - 1) > EPS) reject("Non-joint node transforms must be identity");
    }
  }
  for (const [doc, buffers, rig] of [[source.doc, source.bytes, a], [target.doc, target.bytes, b]] as const) {
    const skin = doc.skins[0], values = skin.inverseBindMatrices === undefined ? [] : accessor(doc, buffers, skin.inverseBindMatrices, "MAT4");
    if (values.length && values.length !== rig.joints.length * 16) reject("Inverse bind matrix count does not match joints");
    for (let k = 0; k < rig.joints.length; k++) {
      const chain: number[] = []; let node: number | undefined = rig.joints[k];
      while (node !== undefined) { chain.unshift(node); node = rig.parents.get(node); }
      const world = new Matrix4();
      for (const id of chain) { const [t, q, s] = pose(rig.nodes[id]); world.multiply(new Matrix4().compose(new Vector3().fromArray(t!), new Quaternion().fromArray(q!), new Vector3().fromArray(s!))); }
      const inverse = values.length ? new Matrix4().fromArray(values, k * 16) : new Matrix4();
      const product = world.multiply(inverse).elements;
      if (product.some((n, i) => Math.abs(n - (i % 5 === 0 ? 1 : 0)) > EPS)) reject("Inverse bind matrices do not match rest pose; re-export the skin");
    }
  }
  for (const pair of mapping) { if (!a.joints.includes(pair.source) || !b.joints.includes(pair.target) || pairs.has(pair.source) || [...pairs.values()].includes(pair.target)) reject("Mapping must be a one-to-one mapping of skin joints"); pairs.set(pair.source, pair.target); }
  if (pairs.size !== a.joints.length || pairs.size !== b.joints.length) reject("Map every joint in both skins");
  for (const [s, t] of pairs) {
    const sp = a.parents.get(s), tp = b.parents.get(t);
    if ((sp === undefined ? undefined : pairs.get(sp)) !== tp) reject("Mapped skeleton hierarchy differs");
    if (!samePose(a.nodes[s], b.nodes[t])) reject(`Rest pose differs for nodes ${s} -> ${t}; pose correction is unsupported`);
  }
  const animations = array(source.doc.animations, "animations"), anim = animations[index(clipIndex, animations, "clip index")];
  const samplers = array(anim?.samplers, "samplers"), channels = array(anim?.channels, "channels");
  if (!channels.length) reject("Animation has no channels");
  const used = new Set<string>();
  for (const channel of channels) {
    const node = channel?.target?.node, path = channel?.target?.path, sampler = samplers[index(channel?.sampler, samplers, "sampler")];
    if (!pairs.has(node) || !["rotation", "translation"].includes(path)) reject("Only explicitly mapped joint rotation and translation channels are supported; scale and weights are rejected");
    const key = `${node}:${path}`;
    if (used.has(key)) reject(`Duplicate ${path} channel`); used.add(key);
    if (!sampler || ![undefined, "LINEAR", "STEP"].includes(sampler.interpolation)) reject("Only LINEAR and STEP interpolation are supported");
    const times = accessor(source.doc, source.bytes, sampler.input, "SCALAR"), values = accessor(source.doc, source.bytes, sampler.output, path === "rotation" ? "VEC4" : "VEC3");
    if (values.length !== times.length * (path === "rotation" ? 4 : 3) || times[0]! < 0 || times.some((x, i) => i > 0 && x <= times[i - 1]!)) reject("Animation times must be nonnegative, strictly increasing and match outputs");
    if (path === "rotation") for (let i = 0; i < values.length; i += 4) if (Math.abs(Math.hypot(...values.slice(i, i + 4)) - 1) > EPS) reject("Animation quaternions must be normalized");
  }
  if (new Set(channels.map(c => c.sampler)).size !== samplers.length) reject("Unused or shared animation samplers are unsupported");
  const name = typeof anim.name === "string" && anim.name ? anim.name : `retargeted_${clipIndex}`;
  const targetAnimations = target.doc.animations === undefined ? [] : array(target.doc.animations, "target animations");
  if (targetAnimations.some(x => x?.name === name)) reject("Target already has an animation with this name");
  // Three's FileLoader emits browser-style progress events even for data URIs in Node.
  if (typeof globalThis.ProgressEvent === "undefined") {
    globalThis.ProgressEvent = class ProgressEvent extends Event {
      readonly lengthComputable: boolean; readonly loaded: number; readonly total: number;
      constructor(type: string, init: ProgressEventInit = {}) { super(type); this.lengthComputable = init.lengthComputable ?? false; this.loaded = init.loaded ?? 0; this.total = init.total ?? 0; }
    } as typeof ProgressEvent;
  }
  const loader = new GLTFLoader();
  try { await loader.parseAsync(source.text, ""); await loader.parseAsync(target.text, ""); } catch (e) { return reject(`GLTFLoader rejected an input: ${String(e)}`); }
  const doc = target.doc, bufferOffset = doc.buffers.length;
  doc.buffers.push(...source.doc.buffers);
  doc.bufferViews ??= []; doc.accessors ??= [];
  const remapAccessor = (id: number) => {
    const original = source.doc.accessors[id], view = source.doc.bufferViews[original.bufferView];
    const v = doc.bufferViews.length; doc.bufferViews.push({ ...view, buffer: view.buffer + bufferOffset });
    const a = doc.accessors.length; doc.accessors.push({ ...original, bufferView: v }); return a;
  };
  const outputSamplers = samplers.map(s => ({ input: remapAccessor(s.input), output: remapAccessor(s.output), ...(s.interpolation ? { interpolation: s.interpolation } : {}) }));
  doc.animations = [...targetAnimations, { name, samplers: outputSamplers, channels: channels.map(c => ({ sampler: c.sampler, target: { node: pairs.get(c.target.node), path: c.target.path } })) }];
  const output = JSON.stringify(doc, null, 2) + "\n";
  if (Buffer.byteLength(output) > LIMIT) reject("Output exceeds 64 MiB");
  try { await loader.parseAsync(output, ""); } catch (e) { return reject(`GLTFLoader rejected output: ${String(e)}`); }
  fs.writeFileSync(outputFile, output, { flag: "wx" });
}
