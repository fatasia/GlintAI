import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { openBrowser } from "@remotion/renderer";

/** Remotion's bundler pulls webpack/rspack and native bindings; packaged builds
 * ship a pre-generated bundle instead and never load it at runtime. */
async function bundleComposition(options: { entryPoint: string; publicDir: string; outDir: string }) {
  const { bundle } = await import("@remotion/bundler");
  return bundle(options);
}

/** One serial render session. New immutable public assets are copied before each job. */
export class RenderSession {
  private readonly root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-session-"));
  readonly publicDir = path.join(this.root, "public");
  constructor() { fs.mkdirSync(this.publicDir); }
  private serveUrl?: string;
  private browser?: Awaited<ReturnType<typeof openBrowser>>;
  readonly stats = { bundles: 0, browsers: 0, jobs: 0 };
  private copyPublic(destination: string) {
    fs.mkdirSync(destination, { recursive: true });
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
    copy(this.publicDir, destination);
  }
  private async prepareBundle(): Promise<string> {
    // Packaged builds ship a pre-generated bundle beside the CLI entry, so a
    // direct CLI invocation works even when the launcher env is absent.
    const siblingBundle = (() => {
      const entry = process.argv[1];
      if (!entry) return undefined;
      const candidate = path.resolve(path.dirname(entry), "..", "remotion-bundle");
      return fs.existsSync(path.join(candidate, "index.html")) ? candidate : undefined;
    })();
    const prebuilt = process.env.GLINT_PREBUILT_BUNDLE ?? siblingBundle;
    if (!prebuilt) {
      return bundleComposition({
        entryPoint: path.resolve("src/index.ts"),
        publicDir: this.publicDir,
        outDir: path.join(this.root, "bundle"),
      });
    }
    // Packaged builds cannot run Remotion's bundler (no webpack/rspack in the
    // package). Copy the pre-generated bundle into this session so public
    // assets stay isolated per job.
    const source = path.resolve(prebuilt);
    if (!fs.existsSync(path.join(source, "index.html")))
      throw new Error(`Prebuilt Remotion bundle is missing index.html: ${source}`);
    const destination = path.join(this.root, "bundle");
    fs.cpSync(source, destination, { recursive: true });
    this.copyPublic(path.join(destination, "public"));
    return destination;
  }
  async acquire() {
    if (!this.serveUrl) {
      this.serveUrl = await this.prepareBundle();
      this.stats.bundles++;
    } else {
      this.copyPublic(path.join(this.serveUrl, "public"));
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
