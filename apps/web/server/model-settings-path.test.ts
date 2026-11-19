import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { modelSettingsFile } from "./model-settings-path";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const temporary = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-model-path-")); roots.push(root); return root; };

it("preserves explicit data directories, including existing relative startup paths", () => {
  expect(modelSettingsFile("llm", { env: { GLINT_DATA_DIR: "data" }, platform: "win32", homeDir: "C:\\Users\\fixture" })).toBe("data\\llm-settings.json");
  expect(modelSettingsFile("llm", { env: { GLINT_DATA_DIR: "/srv/glint" }, platform: "linux", homeDir: "/home/fixture" })).toBe("/srv/glint/llm-settings.json");
});

it("uses user-local Windows storage without sharing the desktop app directory", () => {
  const options = { platform: "win32" as const, homeDir: "C:\\Users\\fixture" };
  expect(modelSettingsFile("llm", { ...options, env: { LOCALAPPDATA: "D:\\Local" } })).toBe("D:\\Local\\Glint\\web\\llm-settings.json");
  for (const env of [{}, { LOCALAPPDATA: "relative" }, { APPDATA: "D:\\Roaming" }]) {
    expect(modelSettingsFile("llm", { ...options, env })).toBe("C:\\Users\\fixture\\AppData\\Local\\Glint\\web\\llm-settings.json");
  }
});

it("uses absolute XDG storage and ignores relative config roots", () => {
  expect(modelSettingsFile("llm", { env: { XDG_CONFIG_HOME: "/config" }, platform: "linux", homeDir: "/home/fixture" })).toBe("/config/glint/web/llm-settings.json");
  for (const env of [{}, { XDG_CONFIG_HOME: "relative" }]) {
    expect(modelSettingsFile("llm", { env, platform: "linux", homeDir: "/home/fixture" })).toBe("/home/fixture/.config/glint/web/llm-settings.json");
  }
  expect(modelSettingsFile("llm", { env: { XDG_CONFIG_HOME: "/ignored" }, platform: "darwin", homeDir: "/Users/fixture" })).toBe("/Users/fixture/Library/Application Support/Glint/web/llm-settings.json");
});

it("does not create or read configuration while resolving a path", () => {
  const root = temporary(), file = modelSettingsFile("llm", { env: {}, homeDir: root });
  expect(path.isAbsolute(file)).toBe(true); expect(fs.readdirSync(root)).toEqual([]);
  expect(() => modelSettingsFile("llm", { env: {}, platform: "linux", homeDir: "relative" })).toThrow(/absolute/);
});

function isolatedService() {
  const root = temporary(), web = fileURLToPath(new URL("..", import.meta.url));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GLINT_")));
  Object.assign(env, { HOME: root, USERPROFILE: root, APPDATA: path.join(root, "roaming"), LOCALAPPDATA: path.join(root, "local"), XDG_CONFIG_HOME: path.join(root, "config"),
    GLINT_STUDIO_DIR: path.join(root, "studio"), GLINT_SESSION_DIR: path.join(root, "sessions"), GLINT_CACHE_DIR: path.join(root, "cache"), NODE_OPTIONS: "" });
  const code = `import { createWebServer } from './server/index.mjs';
const server=createWebServer(); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
try { const base='http://127.0.0.1:'+server.address().port+'/api/settings/';
 const values={llm:{baseUrl:'https://model.test/v1',apiKey:'fixture-private-key',model:'small-model',protocol:'openai'},media:{baseUrl:'https://media.test/v1',apiKey:'fixture-media-key',protocol:'skills'}};
 if(process.argv[1]==='save')for(const [kind,value] of Object.entries(values)){const saved=await fetch(base+kind,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)});if(!saved.ok)throw Error('save failed');}
 const result={};for(const kind of ['llm','media']){const response=await fetch(base+kind);if(!response.ok)throw Error('read failed');result[kind]=await response.json();}console.log(JSON.stringify(result));
} finally { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }`;
  const run = (mode: string) => {
    const child = spawnSync(process.execPath, ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href, "--input-type=module", "-e", code, mode], { cwd: web, env, encoding: "utf8", timeout: 15000, windowsHide: true });
    expect(child.error).toBeUndefined(); expect(child.status, child.stderr).toBe(0);
    for (const key of ["fixture-private-key", "fixture-media-key", "legacy-private-key"]) { expect(child.stdout).not.toContain(key); expect(child.stderr).not.toContain(key); }
    return JSON.parse(child.stdout.trim());
  };
  return { root, env, run };
}

it("persists both default Web model settings through independent HTTP process restarts", () => {
  const { root, env, run } = isolatedService();
  for (const mode of ["save", "read"]) {
    expect(run(mode)).toMatchObject({ llm: { configured: true, model: "small-model", protocol: "openai", storage: "saved" }, media: { configured: true, baseUrl: "https://media.test/v1", source: "saved" } });
  }
  for (const kind of ["llm", "media"] as const) {
    expect(fs.existsSync(modelSettingsFile(kind, { env, homeDir: root }))).toBe(true);
    expect(fs.existsSync(path.join(root, "studio", `${kind}-settings.json`))).toBe(false);
    expect(fs.existsSync(path.join(root, "studio", `.${kind}-settings.json`))).toBe(false);
  }
});

it("keeps an existing legacy media settings file in place without copying credentials", () => {
  const { root, env, run } = isolatedService(), legacy = path.join(env.GLINT_STUDIO_DIR!, ".media-settings.json");
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, JSON.stringify({ baseUrl: "https://legacy.test/v1", apiKey: "legacy-private-key", protocol: "skills" }));
  expect(run("read").media).toMatchObject({ configured: true, baseUrl: "https://legacy.test/v1", source: "saved" });
  expect(run("save").media).toMatchObject({ configured: true, baseUrl: "https://media.test/v1", source: "saved" });
  expect(JSON.parse(fs.readFileSync(legacy, "utf8")).baseUrl).toBe("https://media.test/v1");
  expect(fs.existsSync(modelSettingsFile("media", { env, homeDir: root }))).toBe(false);
});

it("prefers explicit data storage over legacy or user defaults", () => {
  const { root, env, run } = isolatedService(); env.GLINT_DATA_DIR = path.join(root, "explicit");
  const legacy = path.join(env.GLINT_STUDIO_DIR!, ".media-settings.json"), content = JSON.stringify({ baseUrl: "https://legacy.test/v1", apiKey: "legacy-private-key", protocol: "skills" });
  fs.mkdirSync(path.dirname(legacy), { recursive: true }); fs.writeFileSync(legacy, content);
  expect(run("read")).toMatchObject({ llm: { configured: false }, media: { configured: false } });
  expect(run("save")).toMatchObject({ llm: { configured: true, storage: "saved" }, media: { configured: true, source: "saved" } });
  for (const kind of ["llm", "media"] as const) {
    expect(fs.existsSync(path.join(env.GLINT_DATA_DIR, `${kind}-settings.json`))).toBe(true);
    expect(fs.existsSync(modelSettingsFile(kind, { env: { ...env, GLINT_DATA_DIR: undefined }, homeDir: root }))).toBe(false);
  }
  expect(fs.readFileSync(legacy, "utf8")).toBe(content);
});
