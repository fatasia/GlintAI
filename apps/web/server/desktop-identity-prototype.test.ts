import { afterEach, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { request } from "node:http";
import { fileURLToPath } from "node:url";
import { createIdentityPrototypeHost } from "./desktop-identity-prototype.mjs";

const entry = fileURLToPath(new URL("./desktop-identity-prototype.mjs", import.meta.url));
const children: ChildProcessWithoutNullStreams[] = [];
async function start() {
  const child = spawn(process.execPath, [entry, "--isolated-child"], { stdio: "pipe", windowsHide: true });
  children.push(child);
  const stderr: string[] = []; child.stderr.on("data", chunk => stderr.push(String(chunk)));
  const [first] = await once(child.stdout, "data");
  const ready = JSON.parse(String(first).trim());
  expect(ready).toEqual({ type: "ready", origin: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/) });
  return { child, origin: ready.origin as string, stderr };
}
async function control(child: ChildProcessWithoutNullStreams, message: unknown) {
  const response = once(child.stdout, "data"); child.stdin.write(JSON.stringify(message) + "\n");
  return JSON.parse(String((await response)[0]).trim());
}
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) { const done = once(child, "exit"); child.kill(); await done; }
  }
});

it("issues only over private child pipes and enforces exact origin, host, path and revocation", async () => {
  const { child, origin, stderr } = await start();
  const { result: token } = await control(child, { id: 1, type: "issue" });
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const call = (headers: Record<string, string>, suffix = "/identity-prototype") => fetch(origin + suffix, { headers, redirect: "manual" });
  const good = { authorization: `Bearer ${token}`, origin };
  expect((await call(good)).status).toBe(200);
  for (const headers of [ {}, { ...good, origin: "https://attacker.example" }, { ...good, origin: origin.replace("http:", "https:") }, { ...good, origin: "null" }, { ...good, authorization: "Bearer invalid" } ]) {
    expect((await call(headers)).status).toBe(403);
  }
  const badHost = await new Promise<number>((resolve, reject) => {
    const req = request(origin + "/identity-prototype", { headers: { ...good, host: "localhost:" + new URL(origin).port } }, res => { res.resume(); resolve(res.statusCode!); });
    req.on("error", reject); req.end();
  });
  expect(badHost).toBe(403);
  expect((await call(good, "/identity-prototype?token=" + token)).status).toBe(403);
  expect((await fetch(origin + "/issue", { method: "POST", headers: { origin } })).status).toBe(403);
  expect((await fetch(origin + "/identity-prototype", { method: "POST", headers: good })).status).toBe(403);
  const response = await call(good); expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.text()).not.toContain(token);
  await control(child, { id: 2, type: "revoke", token });
  expect((await call(good)).status).toBe(403);
  expect(stderr.join("")).not.toContain(token);
});

it("models controlled main-frame documents, replacement and revocation without exposing tokens", async () => {
  const { child, origin } = await start();
  const host = createIdentityPrototypeHost(child, origin);
  const document = {}, source = { origin, mainFrame: true, document };
  await host.attach(source);
  expect(await host.probe(source)).toEqual({ ok: true });
  for (const bad of [{ ...source, mainFrame: false }, { ...source, origin: "https://attacker.example" }, { ...source, origin: origin.replace("http:", "https:") }, { ...source, document: {} }]) {
    await expect(host.probe(bad)).rejects.toThrow();
  }
  await expect(host.attach({ ...source, mainFrame: false })).rejects.toThrow();
  const next = { ...source, document: {} };
  await host.attach(next);
  await expect(host.probe(source)).rejects.toThrow();
  expect(await host.probe(next)).toEqual({ ok: true });
  await host.revoke(); await expect(host.probe(next)).rejects.toThrow();
  host.close(); await expect(host.attach(source)).rejects.toThrow();
});

it("invalidates an issuance racing with navigation and closes when the private pipe breaks", async () => {
  const { child, origin } = await start();
  const host = createIdentityPrototypeHost(child, origin);
  const source = { origin, mainFrame: true, document: {} };
  const issuance = host.attach(source); await host.revoke();
  await expect(issuance).rejects.toThrow();
  await expect(host.probe(source)).rejects.toThrow();
  child.stdin.end(); await once(child, "exit");
  await expect(host.attach(source)).rejects.toThrow();
});
