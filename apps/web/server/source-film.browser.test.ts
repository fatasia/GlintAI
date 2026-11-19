import { openHomeTool } from "./browser-workspace-helpers";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { expect, it, vi } from "vitest";
import { findSystemBrowser, openCaptureBrowser } from "../../studio/scripts/direct-browser/host";

const enabled = process.env.GLINT_SOURCE_FILM_E2E === "1";
const article = `# 城市社区用水观察

## 现状与问题
本次示例调查覆盖三个社区，记录居民用水习惯与公共设施使用情况，持续比较不同月份的用水变化，并结合居民反馈、公共设施检查记录以及水表读数分析早晚高峰的需求，同时考虑不同家庭的居住人数、入住时间、设备使用方式与计量误差对调查结果可能产生的影响，重点关注老旧管道维护和社区服务。调查数据仅用于说明演示场景，并不代表实际城市统计结果。社区管理者需要同时观察需求变化和设备状况，避免只用单一指标判断。

## 具体措施
第一步是定期检查水表和公共管线，记录异常波动。第二步是向居民解释节水设备的使用方法，并为特殊家庭提供必要帮助。第三步是比较连续月份的数据，区分天气变化与设备故障，避免误把季节变化当成维修成效。每项措施都需要保留实施时间和检查记录，便于后续复核。

## 评估与限制
评估时应比较维修前后的漏损情况，同时记录参与家庭数量。短期数据不能证明所有变化都由某一项措施造成，因为天气、入住率和计量误差也可能影响结果。下一阶段应扩大样本，并在相同季节重复观察，以减少偶然波动的影响。
`;
const csv = "月份,用水量\n一月,12\n二月,25\n三月,18\n四月,34\n";

it.skipIf(!enabled)("imports Chinese long-form and a table through the product and renders both films", async () => {
  findSystemBrowser();
  const evidenceBase = path.resolve(process.env.GLINT_SOURCE_FILM_EVIDENCE || "evidence/CREATE-01/chinese-table-film");
  fs.mkdirSync(evidenceBase, { recursive: true });
  const root = fs.mkdtempSync(path.join(evidenceBase, "run-"));
  const articlePath = path.join(root, "社区用水.md"), tablePath = path.join(root, "用水统计.csv");
  fs.writeFileSync(articlePath, article, { flag: "wx" }); fs.writeFileSync(tablePath, csv, { flag: "wx" });
  const studioSource = path.resolve("apps/studio");
  const studioDir = path.join(root, "apps", "studio");
  fs.mkdirSync(studioDir, { recursive: true });
  fs.cpSync(path.resolve("packages/video/src"), path.join(root, "packages/video/src"), { recursive: true });
  for (const entry of ["scripts", "src", "package.json", "remotion.config.ts"]) {
    fs.cpSync(path.join(studioSource, entry), path.join(studioDir, entry), { recursive: true });
  }
  fs.symlinkSync(path.join(studioSource, "node_modules"), path.join(studioDir, "node_modules"), "junction");
  const savedEnv = { ...process.env };
  for (const key of Object.keys(process.env)) if (key.startsWith("GLINT_") || key === "INIT_CWD") delete process.env[key];
  const tempDir = path.join(root, "temp"); fs.mkdirSync(tempDir);
  Object.assign(process.env, {
    GLINT_DATA_DIR: path.join(root, "product-data"),
    GLINT_SESSION_DIR: path.join(root, "sessions"),
    GLINT_CACHE_DIR: path.join(root, "cache"),
    GLINT_STUDIO_DIR: studioDir,
    GLINT_WEB_DIST: path.join(root, "web-dist"),
    GLINT_STYLE_SAMPLE_DIR: path.join(root, "style-samples"),
    TEMP: tempDir, TMP: tempDir, TMPDIR: tempDir,
  });
  const vite = path.resolve("apps/web/node_modules/vite/bin/vite.js");
  const build = spawnSync(process.execPath, [vite, "build", "--outDir", process.env.GLINT_WEB_DIST!], { cwd: path.resolve("apps/web"), env: process.env, encoding: "utf8", windowsHide: true, timeout: 180000 });
  expect(build.status, `隔离前端构建失败: ${build.stderr}\n${build.stdout}`).toBe(0);
  // index.mjs initializes stores at import time; clear its module cache only after isolation is configured.
  vi.resetModules();
  const { createJobRunner } = await import("./jobs.mjs");
  const runner = createJobRunner({ studioDir, outputDir: path.join(root, "jobs") });
  // @ts-expect-error JavaScript product server.
  const { createWebServer } = await import("./index.mjs");
  const server = createWebServer({ makeRunner: runner }) as Server;
  let browser: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    browser = await openCaptureBrowser(1280, 900);
    const page = browser.page;
    const openTool = async (tool: "export" | "create") => {
      if (await page.$eval('#workspace-tools', el => Boolean(el.getClientRects().length))) await page.locator('.workspace-tools-heading button').click();
      if (tool === "export") await page.locator('.workspace-export').click();
      else { await page.locator('.workspace-more > summary').click(); await page.locator('.workspace-more button::-p-text(更多创作选项)').click(); }
    };
    const errors: string[] = [], requests: unknown[] = [];
    page.on("pageerror", error => errors.push(String(error)));
    page.on("request", request => { if (request.url().endsWith("/api/make")) requests.push(JSON.parse(request.postData() || "{}")); });
    page.on("dialog", dialog => void dialog.accept());
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { waitUntil: "networkidle0" });
    await openHomeTool(page, "create");
    const sourceInput = await page.waitForSelector('input[aria-label="选择资料文件"]');
    await sourceInput!.uploadFile(articlePath);
    await page.waitForSelector('[aria-label="资料文件预览"]', { visible: true });
    expect(await page.$eval('[aria-label="资料文件预览"]', el => (el as HTMLTextAreaElement).value)).toContain("评估与限制");
    await page.click('textarea[aria-label="资料文件预览"]');
    await page.keyboard.down("Control"); await page.keyboard.press("A"); await page.keyboard.up("Control");
    await page.keyboard.sendCharacter(article.replace("老旧管道维护", "老旧管道漏损维护"));
    await page.waitForFunction(() => (document.querySelector('textarea[aria-label="资料文件预览"]') as HTMLTextAreaElement)?.value.includes("老旧管道漏损维护"));
    await page.screenshot({ path: path.join(root, "article-preview.png") });
    await page.locator('button::-p-text(替换资料)').click();
    expect(await page.$eval('textarea[aria-label="创作资料"]', el => (el as HTMLTextAreaElement).value)).toBe(article.replace("老旧管道维护", "老旧管道漏损维护"));
    expect(await page.$eval('select[aria-label="配音"]', el => (el as HTMLSelectElement).value)).toBe("mock");
    await openTool('export'); await page.locator('button::-p-text(生成草稿)').click();
    await page.screenshot({ path: path.join(root, "article-submit.png") });
    fs.writeFileSync(path.join(root, "article-submit-state.txt"), await page.evaluate(() => document.body.innerText));
    expect(requests.length, "生成草稿应提交离线作业；请检查 article-submit-state.txt").toBe(1);
    const waitForJob = async (index: number) => {
      const deadline = Date.now() + 300000;
      while (Date.now() < deadline) {
        const payload = requests[index] as { requestId?: string } | undefined;
        const job = payload?.requestId ? runner.findRequest(payload.requestId) : null;
        if (job?.status === "failed" || job?.status === "cancelled") throw new Error(`渲染${job.status}: ${job.error ?? "无详情"}`);
        if (job?.status === "done") return;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      throw new Error("渲染超过 5 分钟");
    };
    await waitForJob(0);
    await page.waitForSelector('video[aria-label="生成的视频"]', { timeout: 20000 });
    await page.screenshot({ path: path.join(root, "article-result.png") });
    const articleUrl = await page.$eval('video[aria-label="生成的视频"]', el => el.getAttribute("src"));
    const articleResponse = await fetch(new URL(articleUrl!, page.url())); expect(articleResponse.status).toBe(200);
    fs.writeFileSync(path.join(root, "article.mp4"), Buffer.from(await articleResponse.arrayBuffer()));
    await openTool('create');
    const tableInput = await page.waitForSelector('input[aria-label="选择表格文件"]');
    await tableInput!.uploadFile(tablePath);
    await page.waitForFunction(() => document.querySelector('[aria-label="表格导入"] table')?.textContent?.includes("四月"));
    await page.click('textarea[aria-label="原始表格"]');
    await page.keyboard.down("Control"); await page.keyboard.press("A"); await page.keyboard.up("Control");
    await page.keyboard.sendCharacter(csv.replace("四月,34", "四月,39"));
    await page.waitForFunction(() => document.querySelector('[aria-label="表格导入"] table')?.textContent?.includes("四月39"));
    await page.screenshot({ path: path.join(root, "table-preview.png") });
    expect(await page.$eval('[aria-label="表格导入"] table', el => el.textContent)).toContain("39");
    await page.locator('button::-p-text(创建图表工程)').click();
    await page.waitForSelector('[aria-label="共享工程编辑"]', { timeout: 30000 });
    await page.screenshot({ path: path.join(root, "table-project.png") });
    expect(await page.$eval('select[aria-label="配音"]', el => (el as HTMLSelectElement).value)).toBe("mock");
    await openTool('export'); await page.locator('button::-p-text(导出 MP4)').click();
    await waitForJob(1);
    await page.waitForFunction(previous => { const video = document.querySelector('video[aria-label="生成的视频"]'); return video && video.getAttribute("src") !== previous; }, { timeout: 20000 }, articleUrl);
    await page.screenshot({ path: path.join(root, "table-result.png") });
    const tableUrl = await page.$eval('video[aria-label="生成的视频"]', el => el.getAttribute("src"));
    const tableResponse = await fetch(new URL(tableUrl!, page.url())); expect(tableResponse.status).toBe(200);
    fs.writeFileSync(path.join(root, "table.mp4"), Buffer.from(await tableResponse.arrayBuffer()));
    fs.writeFileSync(path.join(root, "requests.json"), JSON.stringify(requests, null, 2));
    const articleJob = runner.findRequest((requests[0] as { requestId: string }).requestId);
    const articleProject = JSON.parse(fs.readFileSync(path.join(root, "jobs", `${articleJob.id}.mp4.project.json`), "utf8"));
    expect(articleProject.scenes.some((scene: { narration: { text: string } }) => scene.narration.text.endsWith("…"))).toBe(true);
    expect(articleProject.scenes.some((scene: { kind: string; items?: string[] }) => scene.kind === "bullets" && scene.items?.some(item => item.endsWith("…")))).toBe(true);
    expect((requests[0] as { source: string; tts: string }).source).toBe(article.replace("老旧管道维护", "老旧管道漏损维护"));
    expect((requests[0] as { tts: string }).tts).toBe("mock");
    const tableRequest = requests[1] as { project: { scenes: Array<{ kind: string; data: unknown }> }; tts: string };
    expect(tableRequest.tts).toBe("mock");
    expect(tableRequest.project.scenes.find(scene => scene.kind === "chart")?.data).toEqual([{ label: "一月", value: 12 }, { label: "二月", value: 25 }, { label: "三月", value: 18 }, { label: "四月", value: 39 }]);
    expect(errors).toEqual([]);
    for (const name of ["article", "table"]) {
      const film = path.join(root, `${name}.mp4`);
      const probe = spawnSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", film], { encoding: "utf8", windowsHide: true });
      expect(probe.status, probe.stderr).toBe(0); fs.writeFileSync(path.join(root, `${name}-probe.json`), probe.stdout);
      const shot = spawnSync("ffmpeg", ["-v", "error", "-ss", "2", "-i", film, "-frames:v", "1", "-y", path.join(root, `${name}-frame.png`)], { encoding: "utf8", windowsHide: true });
      expect(shot.status, shot.stderr).toBe(0);
    }
  } finally {
    await browser?.browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    runner.dispose();
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  }
}, 600000);
