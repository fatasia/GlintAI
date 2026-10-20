import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { gltfExternalResources, LocalAssetPath, parseProject, readGltfDocument, Scene } from "./index";

const narration = { text: "Local asset" };
const fixture = new URL("../../../examples/local-media/", import.meta.url);

describe("local media schema", () => {
  it.each(["torus-knot", "icosahedron", "sphere"])("preserves legacy geometry %s", (model) => {
    expect(Scene.safeParse({ id: "model", kind: "three", model, narration }).success).toBe(true);
  });
  it.each(["cube.gltf", "cube.glb"])("accepts local model %s", (file) => {
    expect(Scene.safeParse({ id: "model", kind: "three", model: "gltf", src: `assets/${file}`, narration }).success).toBe(true);
  });
  it("requires glTF src and extension", () => {
    for (const src of [undefined, "assets/model.obj", "https://host/model.glb"]) {
      expect(Scene.safeParse({ id: "model", kind: "three", model: "gltf", src, narration }).success).toBe(false);
    }
  });
  it.each(["", "/assets/a.png", "C:/assets/a.png", "assets/../a.png", "assets/./a.png", "assets//a.png", "assets/a\\b.png", "assets/%2e%2e/a", "assets/a?x", "assets/a#x", "assets/a.", "assets/CON.png", "https://host/a", "//host/a", "data:image/png;base64,AA=="])("rejects unsafe src %s", (src) => {
    expect(LocalAssetPath.safeParse(src).success).toBe(false);
    expect(Scene.safeParse({ id: "image", kind: "image", src, narration }).success).toBe(false);
  });
  it("accepts Unicode nested image paths and the complete fixture", () => {
    expect(LocalAssetPath.parse("assets/图像/a b.png")).toBe("assets/图像/a b.png");
    expect(parseProject(JSON.parse(fs.readFileSync(new URL("project.scenescript.json", fixture), "utf8"))).scenes).toHaveLength(5);
  });
});

describe("glTF document guard", () => {
  it("reads authored external glTF and embedded GLB", () => {
    const external = readGltfDocument(fs.readFileSync(new URL("assets/models/cube.gltf", fixture)));
    expect(gltfExternalResources(external)).toEqual(["textures/checker.png", "cube.bin"]);
    expect(gltfExternalResources(readGltfDocument(fs.readFileSync(new URL("assets/models/cube.glb", fixture))))).toEqual([]);
  });
  it.each(["../texture.png", "/texture.png", "https://host/texture.png", "file:///texture", "//host/a", "%2e%2e/a", "textures/../../a", "data:image/svg+xml;base64,AA==", "blob:unknown", "C:/a"])("rejects nested URI %s", (uri) => {
    expect(() => gltfExternalResources({ extensions: { custom: { uri } } })).toThrow(/Unsafe/);
  });
  it("allows bounded-format embedded buffers and raster images", () => {
    expect(gltfExternalResources({ buffers: [{ uri: "data:application/octet-stream;base64,AAAA" }], images: [{ uri: "data:image/png;base64,AAAA" }] })).toEqual([]);
  });
  it.each(["KHR_draco_mesh_compression", "KHR_texture_basisu"])("allows self-hosted decoder %s", (name) => {
    expect(gltfExternalResources({ extensionsUsed: [name] })).toEqual([]);
    expect(gltfExternalResources({ extensions: { [name]: {} } })).toEqual([]);
  });
  it.each(["EXT_meshopt_compression"])("rejects unconfigured decoder %s", (name) => {
    expect(() => gltfExternalResources({ extensionsUsed: [name] })).toThrow(/decoder/);
    expect(() => gltfExternalResources({ extensions: { [name]: {} } })).toThrow(/decoder/);
  });
  it("rejects invalid documents and truncated GLBs", () => {
    expect(() => readGltfDocument(new TextEncoder().encode('{"asset":{"version":"1.0"}}'))).toThrow();
    const glb = fs.readFileSync(new URL("assets/models/cube.glb", fixture));
    expect(() => readGltfDocument(glb.subarray(0, glb.length - 1))).toThrow(/length/);
    const badChunk = Buffer.from(glb); badChunk.writeUInt32LE(0xffffffff, 12);
    expect(() => readGltfDocument(badChunk)).toThrow(/chunk/);
  });
});
