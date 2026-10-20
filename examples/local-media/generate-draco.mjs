// Regenerate the original cube's DRACO fixture using the encoder bundled with Three.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../../packages/video/package.json', import.meta.url));
const source = require.resolve('three/examples/jsm/libs/draco/gltf/draco_encoder.js');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'glint-draco-generator-'));
const encoderFile = path.join(temp, 'encoder.cjs'); fs.copyFileSync(source, encoderFile);
const module = require(encoderFile)({});
const dir = fileURLToPath(new URL('./assets/models/', import.meta.url));
const document = JSON.parse(fs.readFileSync(path.join(dir, 'cube.gltf'), 'utf8'));
const binary = fs.readFileSync(path.join(dir, 'cube.bin'));
const floats = (offset, count) => new Float32Array(binary.buffer, binary.byteOffset + offset, count);
const mesh = new module.Mesh(), builder = new module.MeshBuilder(), encoder = new module.Encoder(), data = new module.DracoInt8Array();
const attributes = {
  POSITION: builder.AddFloatAttributeToMesh(mesh, module.POSITION, 24, 3, floats(0, 72)),
  NORMAL: builder.AddFloatAttributeToMesh(mesh, module.NORMAL, 24, 3, floats(288, 72)),
  TEXCOORD_0: builder.AddFloatAttributeToMesh(mesh, module.TEX_COORD, 24, 2, floats(576, 48)),
};
builder.AddFacesToMesh(mesh, 12, new Uint16Array(binary.buffer, binary.byteOffset + 768, 36));
encoder.SetSpeedOptions(5, 5); encoder.SetAttributeQuantization(module.POSITION, 14);
const length = encoder.EncodeMeshToDracoBuffer(mesh, data);
if (length <= 0) throw new Error('DRACO encoder failed');
const compressed = Buffer.alloc(length);
for (let i = 0; i < length; i++) compressed.writeInt8(data.GetValue(i), i);
const aligned = Math.ceil(length / 4) * 4;
const output = Buffer.concat([compressed, Buffer.alloc(aligned - length), binary.subarray(840)]);
fs.writeFileSync(path.join(dir, 'cube-draco.bin'), output);
document.asset.generator = 'Glint original cube; Three bundled DRACO encoder';
document.extensionsUsed = document.extensionsRequired = ['KHR_draco_mesh_compression'];
document.buffers = [{ uri: 'cube-draco.bin', byteLength: output.length }];
document.bufferViews = [{ buffer: 0, byteOffset: 0, byteLength: length }, { buffer: 0, byteOffset: aligned, byteLength: 12 }, { buffer: 0, byteOffset: aligned + 12, byteLength: 48 }];
document.accessors.forEach((accessor, index) => { if (index < 4) delete accessor.bufferView; else accessor.bufferView = index - 3; });
document.meshes[0].primitives[0].extensions = { KHR_draco_mesh_compression: { bufferView: 0, attributes } };
fs.writeFileSync(path.join(dir, 'cube-draco.gltf'), JSON.stringify(document, null, 2));
for (const object of [data, encoder, builder, mesh]) module.destroy(object);
console.log(`DRACO fixture: ${length} compressed mesh bytes, ${output.length} with animation; generated from the repository's original cube.`);
