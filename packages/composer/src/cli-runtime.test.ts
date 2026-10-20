import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createCliRuntime, resolvePaths, sourceInput, renderArgs } from "../../../apps/studio/scripts/glint-runtime";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
const entry = new URL("../../../apps/studio/scripts/glint.ts", import.meta.url).href;
const studio = fileURLToPath(new URL("../../../apps/studio/", import.meta.url));
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); });

describe("CLI paths and shell-free invocation", () => {
  it("resolves every filesystem argument against caller, not Studio", () => {
    const caller = path.resolve("外部目录 space");
    const args = ["source", "code", "project", "out", "music"].map((key) => `--${key}=子目录/a&b;$(bad).md`);
    expect(resolvePaths(args, caller)).toEqual(args.map((arg) => {
      const [key, value] = arg.split("=");
      return `${key}=${path.resolve(caller, value!)}`;
    }));
    expect(resolvePaths(["--music=auto", "--music=off", "--title=a=b"], caller)).toEqual(["--music=auto", "--music=off", "--title=a=b"]);
  });
  it("preserves public source URLs rather than mangling into paths", () => {
    const args = resolvePaths(["--source=https://example.com/a?x=1&y=2"], studio);
    expect(sourceInput(args)).toEqual({ path: undefined, url: "https://example.com/a?x=1&y=2", idea: undefined, code: undefined });
    expect(() => sourceInput([...args, "--url=https://other.example"])).toThrow("exactly one");
    expect(() => resolvePaths(["--source=file:///secret"], studio)).toThrow("HTTP(S)");
  });
  it.each(["source", "code", "project", "out", "music"])("rejects blank --%s", (key) => {
    expect(() => resolvePaths([`--${key}=  `], studio)).toThrow("requires a path");
  });
  it("honors INIT_CWD and defaults to current cwd for direct node", () => {
    vi.stubEnv("INIT_CWD", path.resolve("调用目录"));
    expect(createCliRuntime(entry).resolvePaths(["--source=doc.md"])).toEqual([`--source=${path.resolve("调用目录/doc.md")}`]);
    vi.stubEnv("INIT_CWD", "");
    expect(createCliRuntime(entry).resolvePaths(["--source=doc.md"])).toEqual([`--source=${path.resolve("doc.md")}`]);
  });
  it("forwards encoding to render without source, engine or credentials", () => {
    expect(renderArgs("/project.json", ["--source=doc.md", "--engine=llm", "--encoding=quality", "--tts=mock", "--api-key=never-forward", "--out=中文 space.mp4"]))
      .toEqual(["--project=/project.json", "--music=auto", "--tts=mock", "--encoding=quality", "--out=中文 space.mp4"]);
  });
  it("forwards still frame and draft mode through make", () => {
    expect(renderArgs("/project.json", ["--format=png", "--frame=45", "--fast"]))
      .toEqual(["--project=/project.json", "--music=auto", "--format=png", "--frame=45", "--fast"]);
  });
  it("keeps media-adapter flags in composition, not rendering",()=>{
    expect(renderArgs("/project.json",["--media-python=python","--transcription-model=/models","--tts=mock"]))
      .toEqual(["--project=/project.json","--music=auto","--tts=mock"]);
    expect(resolvePaths(["--transcription-model=models","--batch=batch.json","--preview-config=preview.json"],studio))
      .toEqual([`--transcription-model=${path.resolve(studio,'models')}`,`--batch=${path.resolve(studio,'batch.json')}`,`--preview-config=${path.resolve(studio,'preview.json')}`]);
  });
  it("uses absolute scripts, Studio cwd and literal argument arrays for every command", async () => {
    vi.mocked(spawn).mockImplementation((() => {
      const child = new EventEmitter(); queueMicrotask(() => child.emit("close", 0)); return child;
    }) as unknown as typeof spawn);
    const runtime = createCliRuntime(entry);
    const args = ['--project=C:/中文 space/a&whoami;$(id).json', '--voice=x" & bad', "--encoding=quality"];
    for (const name of ["render", "ask", "rehearse", "reexplain"]) {
      await runtime.runScript(name, args);
      const call = vi.mocked(spawn).mock.lastCall!;
      expect(call[0]).toBe(process.execPath);
      expect(call[1]).toEqual(["--import", expect.stringMatching(/^file:/), path.join(studio, "scripts", `${name}.ts`), ...args]);
      expect(call[2]).toMatchObject({ cwd: path.resolve(studio), shell: false, stdio: "inherit" });
    }
    await runtime.runStudio();
    expect(vi.mocked(spawn).mock.lastCall![1]).toEqual([expect.stringContaining("remotion-cli.js"), "studio", "src/index.ts"]);
    expect(() => runtime.scriptArgs("../outside", [])).toThrow("Unknown CLI script");
  });
  it.each([1, null])("propagates child failure %s", async (code) => {
    vi.mocked(spawn).mockImplementation((() => {
      const child = new EventEmitter(); queueMicrotask(() => child.emit("close", code, "SIGTERM")); return child;
    }) as unknown as typeof spawn);
    await expect(createCliRuntime(entry).runScript("render", [])).rejects.toThrow("command exited");
  });
  it("propagates spawn errors instead of hanging", async () => {
    vi.mocked(spawn).mockImplementation((() => {
      const child = new EventEmitter(); queueMicrotask(() => child.emit("error", new Error("ENOENT"))); return child;
    }) as unknown as typeof spawn);
    await expect(createCliRuntime(pathToFileURL(fileURLToPath(entry)).href).runScript("ask", [])).rejects.toThrow("ENOENT");
  });
});
