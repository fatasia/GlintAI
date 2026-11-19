import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const mocks = vi.hoisted(() => ({ compose: vi.fn(), repair: vi.fn(), table: vi.fn(), nativeRender: vi.fn(), referenceRender: vi.fn(), studioDir: "" }));
vi.mock("./glint-runtime", async importOriginal => {
  const original = await importOriginal<typeof import("./glint-runtime")>();
  return { ...original, createCliRuntime: () => ({ studioDir: mocks.studioDir, resolvePaths: (args: string[]) => args, runScript: mocks.referenceRender }) };
});
vi.mock("@glintai/composer", async importOriginal => ({ ...await importOriginal<typeof import("@glintai/composer")>(), composeFromSource: mocks.compose }));
vi.mock("@glintai/llm", async importOriginal => ({ ...await importOriginal<typeof import("@glintai/llm")>(), llmFromEnvironment: () => ({}) }));
vi.mock("./beat-policy", () => ({ beatsForMake: async () => undefined }));
vi.mock("./presentation-repair", () => ({ repairPresentation: mocks.repair }));
vi.mock("./make-quality", () => ({ renderWithQualityGate: mocks.nativeRender }));
vi.mock("./table-sources", () => ({ tableProject: mocks.table }));

const base = { schemaVersion: 1, id: "motion09", title: "边界", aspect: "16:9", knowledgeSources: [], scenes: [{ id: "title", kind: "title", title: "标题", narration: { text: "讲解" } }] };
const html = { id: "html", kind: "html", html: "<script>globalThis.pwned=true</script>", animation: "gsap", narration: { text: "讲解" } };
const three = { id: "three", kind: "three", model: "gltf", src: "assets/model.glb", narration: { text: "讲解" } };
let runMake: typeof import("./glint").runMake;

beforeAll(async () => {
  mocks.studioDir = fs.mkdtempSync(path.join(os.tmpdir(), "glint-motion09-"));
  ({ runMake } = await import("./glint"));
});
afterAll(() => fs.rmSync(mocks.studioDir, { recursive: true, force: true }));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

function setup(project: unknown, final = project) {
  vi.stubEnv("GLINT_LLM_API_KEY", "test-key");
  mocks.compose.mockResolvedValue({ project, sourceText: "测试内容" });
  mocks.repair.mockReturnValue({ project: final, changes: [], issues: [], verdict: "green" });
  mocks.nativeRender.mockResolvedValue({ output: "mock.mp4" });
  mocks.referenceRender.mockResolvedValue(undefined);
}

describe("MOTION-09 generated Web make policy", () => {
  for (const backend of ["native", "reference"]) {
    for (const scene of [html, three]) {
      it(`rejects generated ${scene.kind} before ${backend} rendering`, async () => {
        vi.stubEnv("GLINT_WEB_MAKE_POLICY", "1");
        setup({ ...base, scenes: [...base.scenes, scene] });
        await expect(runMake(["--idea=测试", "--engine=llm", `--backend=${backend}`])).rejects.toThrow(/HTML 或 3D/);
        expect(mocks.nativeRender).not.toHaveBeenCalled();
        expect(mocks.referenceRender).not.toHaveBeenCalled();
      });
    }
    it(`checks the final repaired project before ${backend} rendering`, async () => {
      vi.stubEnv("GLINT_WEB_MAKE_POLICY", "1");
      setup(base, { ...base, scenes: [html] });
      await expect(runMake(["--idea=测试", `--backend=${backend}`])).rejects.toThrow(/HTML 或 3D/);
      expect(mocks.nativeRender).not.toHaveBeenCalled();
      expect(mocks.referenceRender).not.toHaveBeenCalled();
    });
    it(`permits a normal generated project on ${backend}`, async () => {
      vi.stubEnv("GLINT_WEB_MAKE_POLICY", "1");
      setup(base);
      await runMake(["--idea=测试", `--backend=${backend}`, ...(backend === "reference" ? ["--format=png"] : [])]);
      expect(backend === "native" ? mocks.nativeRender : mocks.referenceRender).toHaveBeenCalledOnce();
    });
  }
  it("fails closed on malformed final projects", async () => {
    vi.stubEnv("GLINT_WEB_MAKE_POLICY", "1");
    setup(base, { ...base, scenes: null });
    await expect(runMake(["--idea=测试"])).rejects.toThrow();
    expect(mocks.nativeRender).not.toHaveBeenCalled();
    expect(mocks.referenceRender).not.toHaveBeenCalled();
  });
  it("rejects unsafe table-derived projects before rendering", async () => {
    vi.stubEnv("GLINT_WEB_MAKE_POLICY", "1");
    mocks.table.mockResolvedValue({ project: { ...base, scenes: [three] }, warnings: [], tables: 1 });
    await expect(runMake(["--source=test.csv"])).rejects.toThrow(/HTML 或 3D/);
    expect(mocks.nativeRender).not.toHaveBeenCalled();
    expect(mocks.referenceRender).not.toHaveBeenCalled();
  });
  it("does not restrict the local CLI without the Web policy", async () => {
    vi.stubEnv("GLINT_WEB_MAKE_POLICY", "");
    setup({ ...base, scenes: [html] });
    await runMake(["--idea=测试"]);
    expect(mocks.nativeRender).toHaveBeenCalledOnce();
  });
});
