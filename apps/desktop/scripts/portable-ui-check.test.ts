import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
// @ts-expect-error native build helper
import { verifyPackagedWebUi } from "./portable-ui-check.mjs";

it.each([false, true])("实际执行打包界面脚本并采用桌面配置；运行异常=%s", async broken => {
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<div aria-label="视频创作起点"><button>影像创作</button><button onclick="document.querySelector('[aria-label=快速成片]').hidden=false">动态图形</button></div><section aria-label="快速成片" hidden>测试界面</section><script type="module">${broken
      ? "throw Error('broken packaged UI');"
      : "const target=Object.create(Object.prototype);target.constructor=function(){};"}</script>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`, repo = fileURLToPath(new URL("../../../", import.meta.url));
    if (broken) await expect(verifyPackagedWebUi(url, repo)).rejects.toThrow("JavaScript errors");
    else expect(await verifyPackagedWebUi(url, repo)).toEqual({ rendered: true, frozenPrototype: false });
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}, 30_000);

it("保留冻结原型配置，并从双入口进入可见的成片表单", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "glint-portable-ui-config-"));
  fs.mkdirSync(path.join(repo, "apps", "desktop"), { recursive: true });
  fs.mkdirSync(path.join(repo, "apps", "studio"), { recursive: true });
  fs.writeFileSync(path.join(repo, "apps", "desktop", "tauri.conf.json"), JSON.stringify({ app: { security: { freezePrototype: true } } }));
  fs.symlinkSync(fileURLToPath(new URL("../../studio/node_modules", import.meta.url)), path.join(repo, "apps", "studio", "node_modules"), "junction");
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<div aria-label="视频创作起点"><button>影像创作</button><button onclick="document.querySelector('[aria-label=快速成片]').hidden=false">动态图形</button></div><section aria-label="快速成片" hidden>测试界面</section>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    expect(await verifyPackagedWebUi(url, repo)).toEqual({ rendered: true, frozenPrototype: true });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(repo, { recursive: true, force: true });
  }
}, 30_000);
