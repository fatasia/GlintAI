import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { createHash } from "node:crypto";

export default defineConfig({
  plugins: [react(), {
    name: "glint-offline-shell",
    enforce: "post",
    generateBundle(_options, output) {
      this.emitFile({ type: "asset", fileName: "assets/geometry.webp", source: fs.readFileSync(fileURLToPath(new URL("../../examples/uncertainty-principle/assets/geometry.webp", import.meta.url))) });
      const shell = new Set<string>(["/", "/manifest.webmanifest", "/icon.svg"]);
      function visit(name: string) {
        if (shell.has(`/${name}`)) return;
        shell.add(`/${name}`);
        const chunk = output[name];
        if (chunk?.type === "chunk") for (const imported of chunk.imports) visit(imported);
      }
      for (const chunk of Object.values(output)) if (chunk.type === "chunk" && chunk.isEntry) visit(chunk.fileName);
      const files = [...shell];
      const available = ["/assets/geometry.webp", ...Object.keys(output).filter((name) => /\.(js|css|woff2?)$/.test(name)).map((name) => `/${name}`)];
      const version = createHash("sha256").update(Object.values(output).map(item => item.type === "chunk" ? item.code : String(item.source)).join("|")).digest("hex").slice(0, 16);
      this.emitFile({ type: "asset", fileName: "sw.js", source: `
const FILES = ${JSON.stringify(files)};
const AVAILABLE = ${JSON.stringify(available)};
const CACHE = 'glint-' + ${JSON.stringify(version)};
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES))));
self.addEventListener('message', event => { if (event.data === 'activate') self.skipWaiting(); });
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('glint-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || (!FILES.includes(url.pathname) && !AVAILABLE.includes(url.pathname)) || url.search) return;
  event.respondWith(caches.match(url.pathname).then(hit => {
    if (hit && url.pathname.startsWith('/assets/') && url.pathname !== '/assets/geometry.webp') return hit;
    return fetch(event.request).then(response => {
      if (response.ok) { const copy = response.clone(); event.waitUntil(caches.open(CACHE).then(cache => cache.put(url.pathname, copy))); }
      return response;
    }).catch(() => hit || Response.error());
  }));
});
` });
    },
    writeBundle() {
      const root = fileURLToPath(new URL("./dist/", import.meta.url));
      for (const name of fs.readdirSync(root, { recursive: true }) as string[]) {
        if (!/\.(js|css|html|json)$/.test(name)) continue;
        const file = `${root}/${name}`;
        const bytes = fs.readFileSync(file);
        if (bytes.length < 1024) continue;
        fs.writeFileSync(`${file}.br`, brotliCompressSync(bytes));
        fs.writeFileSync(`${file}.gz`, gzipSync(bytes, { level: 9 }));
      }
    },
  }],
  // This bundled, public example owns assets/geometry.webp used by the web player.
  // Publish no Studio output tree or user uploads.
  publicDir: fileURLToPath(new URL("./public", import.meta.url)),
  server: {
    fs: {
      // Examples live at the workspace root.
      allow: ["../.."],
    },
  },
  build: {
    manifest: true,
  },
});
