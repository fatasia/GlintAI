// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GltfModel } from "./GltfModel";
const mocks = vi.hoisted(() => {
  const finish = vi.fn();
  return {
    three: { gl: { render: vi.fn(), getContext: () => ({ finish }) }, scene: {}, camera: {} }, finish,
    load: vi.fn(), seek: vi.fn(), dispose: vi.fn(),
    mixer: { stopAllAction: vi.fn(), uncacheRoot: vi.fn() },
    delay: vi.fn(() => 1), release: vi.fn(), cancel: vi.fn(),
  };
});
vi.mock("@react-three/fiber", () => ({ useThree: (selector: (state: unknown) => unknown) => selector(mocks.three) }));
vi.mock("remotion", () => ({ delayRender: mocks.delay, continueRender: mocks.release, cancelRender: mocks.cancel, staticFile: (src: string) => `/public/${src}` }));
vi.mock("./gltf", () => ({
  loadLocalGltf: mocks.load, seekGltfAnimation: mocks.seek, disposeGltf: mocks.dispose,
  createGltfMixer: () => mocks.mixer, fitGltf: () => ({ scale: 1, position: [0, 0, 0] }), attachGltfDecoders: vi.fn(),
}));
const cleanups: (() => void)[] = [];
beforeAll(() => { (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { cleanups.splice(0).forEach((cleanup) => cleanup()); vi.restoreAllMocks(); });
function mount() {
  const container = document.createElement("div"); const root = createRoot(container);
  // React DOM is only a lifecycle harness, not a Three renderer. These custom
  // elements intentionally stand in for R3F host objects in this unit test.
  vi.spyOn(console, "error").mockImplementation(() => {});
  act(() => root.render(createElement(GltfModel, { src: "assets/cube.glb", frame: 7, fps: 30 })));
  cleanups.push(() => act(() => root.unmount()));
}
describe("async glTF first-frame capture", () => {
  it("seeks, draws and finishes the GPU before releasing the loaded model", async () => {
    let resolve!: (gltf: { scene: object }) => void;
    mocks.load.mockReturnValue(new Promise((yes) => { resolve = yes; }));
    mount();
    expect(mocks.delay).toHaveBeenCalledTimes(1);
    expect(mocks.release).not.toHaveBeenCalled();
    await act(async () => { resolve({ scene: {} }); });
    expect(mocks.seek).toHaveBeenCalledWith(mocks.mixer, 7, 30);
    expect(mocks.three.gl.render).toHaveBeenCalledWith(mocks.three.scene, mocks.three.camera);
    const order = [mocks.seek, mocks.three.gl.render, mocks.finish, mocks.release].map((fn) => fn.mock.invocationCallOrder[0]);
    expect(order).toEqual([...order].sort((a, b) => a! - b!));
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });
  it("cancels load failure without releasing a bad frame", async () => {
    mocks.load.mockRejectedValue(new Error("missing bin"));
    await act(async () => mount());
    expect(mocks.cancel).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("missing bin") }));
    expect(mocks.release).not.toHaveBeenCalled(); expect(mocks.three.gl.render).not.toHaveBeenCalled();
  });
  it("cancels GPU failure without releasing a bad frame", async () => {
    mocks.load.mockResolvedValue({ scene: {} });
    mocks.three.gl.render.mockImplementationOnce(() => { throw new Error("lost context"); });
    await act(async () => mount());
    expect(mocks.cancel).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("lost context") }));
    expect(mocks.release).not.toHaveBeenCalled();
  });
  it("disposes a model that finishes loading after unmount", async () => {
    let resolve!: (gltf: { scene: object }) => void;
    mocks.load.mockReturnValue(new Promise((yes) => { resolve = yes; })); mount();
    cleanups.splice(0).forEach((cleanup) => cleanup());
    const gltf = { scene: {} }; await act(async () => { resolve(gltf); });
    expect(mocks.dispose).toHaveBeenCalledWith(gltf);
    expect(mocks.three.gl.render).not.toHaveBeenCalled(); expect(mocks.release).toHaveBeenCalledTimes(1);
  });
});
