import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { bundle } from "@remotion/bundler";
import { openBrowser } from "@remotion/renderer";

/** One serial render session. New immutable public assets are copied before each job. */
export class RenderSession {
  private readonly root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-session-"));
  readonly publicDir = path.join(this.root, "public");
  constructor() { fs.mkdirSync(this.publicDir); }
  private serveUrl?: string;
  private browser?: Awaited<ReturnType<typeof openBrowser>>;
  readonly stats = { bundles: 0, browsers: 0, jobs: 0 };
  async acquire() {
    if (!this.serveUrl) {
      this.serveUrl = await bundle({
        entryPoint: path.resolve("src/index.ts"),
        publicDir: this.publicDir,
        outDir: path.join(this.root, "bundle"),
      });
      this.stats.bundles++;
    } else {
      const source = this.publicDir,
        destination = path.join(this.serveUrl, "public");
      const copy = (from: string, to: string) => {
        for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
          if (entry.isSymbolicLink())
            throw new Error("Public assets must not contain symlinks");
          const input = path.join(from, entry.name),
            output = path.join(to, entry.name);
          if (entry.isDirectory()) {
            fs.mkdirSync(output, { recursive: true });
            copy(input, output);
          } else if (entry.isFile() && !fs.existsSync(output))
            fs.copyFileSync(input, output);
        }
      };
      copy(source, destination);
    }
    if (!this.browser) {
      this.browser = await openBrowser("chrome", { ...(process.env.GLINT_CHROME_EXECUTABLE ? { browserExecutable: process.env.GLINT_CHROME_EXECUTABLE } : {}) });
      this.stats.browsers++;
    }
    this.stats.jobs++;
    return { serveUrl: this.serveUrl, puppeteerInstance: this.browser };
  }
  async dispose() {
    try { await this.browser?.close({ silent: true }); }
    finally {
      this.browser = undefined;
      this.serveUrl = undefined;
      const target = path.resolve(this.root);
      if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith("glint-session-")) throw new Error("Refusing to clean an unowned render session directory");
      fs.rmSync(target, { recursive: true, force: true });
    }
  }
}
