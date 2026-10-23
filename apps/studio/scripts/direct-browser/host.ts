import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

/**
 * Capture browser candidates, best-effort and in preference order. Windows ships
 * Edge, so a machine without Chrome can still render; GLINT_CHROME_PATH always wins.
 */
export function browserCandidates(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string[] {
  const programFiles = env.PROGRAMFILES ?? "C:/Program Files";
  const programFilesX86 = env["PROGRAMFILES(X86)"] ?? "C:/Program Files (x86)";
  const localAppData = env.LOCALAPPDATA ?? "";
  const windows = [
    `${programFiles}/Google/Chrome/Application/chrome.exe`,
    `${localAppData}/Google/Chrome/Application/chrome.exe`,
    `${programFiles}/Microsoft/Edge/Application/msedge.exe`,
    `${programFilesX86}/Microsoft/Edge/Application/msedge.exe`,
  ];
  const macos = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"];
  const linux = ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/usr/bin/microsoft-edge"];
  const platformCandidates = platform === "win32" ? windows : platform === "darwin" ? macos : linux;
  return [env.GLINT_CHROME_PATH, ...platformCandidates].filter((value): value is string => Boolean(value && value.trim()));
}

export function findSystemBrowser(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
  exists: (file: string) => boolean = file => fs.existsSync(file),
): string {
  const candidates = browserCandidates(env, platform);
  const found = candidates.find(file => exists(file));
  if (!found) throw new Error(`No Chromium capture browser found. Checked: ${candidates.join(", ")}. Install Chrome/Edge or set GLINT_CHROME_PATH; nothing is downloaded automatically.`);
  return found;
}

/**
 * Identity of the browser binary itself. The old cache key ignored the browser
 * version, so a Chrome update could reuse frames rendered by the previous one.
 * Size + mtime avoids launching the browser just to ask its version.
 */
export function browserIdentity(): string | undefined {
  try {
    const file = findSystemBrowser(), stat = fs.statSync(file);
    return createHash("sha256").update(`${file}:${stat.size}:${stat.mtimeMs}`).digest("hex");
  } catch {
    return undefined;
  }
}

const mime: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".mp4": "video/mp4", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".gltf": "model/gltf+json", ".glb": "model/gltf-binary", ".wasm": "application/wasm" };

export async function startAssetServer(root: string) {
  const base = fs.realpathSync(root);
  const server = createServer((request, response) => {
    try {
      if (!["GET", "HEAD"].includes(request.method ?? "")) { response.writeHead(405).end(); return; }
      const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
      const file = fs.realpathSync(path.join(base, pathname === "/" ? "index.html" : pathname));
      const relative = path.relative(base, file);
      if (relative.startsWith("..") || path.isAbsolute(relative) || !fs.statSync(file).isFile()) { response.writeHead(403).end(); return; }
      const size = fs.statSync(file).size, range = request.headers.range;
      response.setHeader("Content-Type", mime[path.extname(file).toLowerCase()] ?? "application/octet-stream");
      response.setHeader("Access-Control-Allow-Origin", "*"); response.setHeader("Accept-Ranges", "bytes");
      if (range) {
        const match = /^bytes=(\d+)-(\d*)$/.exec(range);
        const start = Number(match?.[1]), end = match?.[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
        if (!match || start > end || start >= size) { response.writeHead(416, { "Content-Range": `bytes */${size}` }).end(); return; }
        response.writeHead(206, { "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
        if (request.method === "HEAD") response.end(); else fs.createReadStream(file, { start, end }).pipe(response);
      } else {
        response.writeHead(200, { "Content-Length": size });
        if (request.method === "HEAD") response.end(); else fs.createReadStream(file).pipe(response);
      }
    } catch { response.writeHead(404).end("Not found"); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Cannot bind local render server");
  return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }) };
}

export async function openCaptureBrowser(width: number, height: number): Promise<{ browser: Browser; page: Page }> {
  const browser = await puppeteer.launch({ executablePath: findSystemBrowser(), headless: true, args: ["--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--autoplay-policy=no-user-gesture-required"], protocolTimeout: 60000 });
  try {
    const page = await browser.newPage(); await page.setViewport({ width, height, deviceScaleFactor: 1 });
    return { browser, page };
  } catch (error) { await browser.close(); throw error; }
}
