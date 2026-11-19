import fs from "node:fs";
import path from "node:path";

/** Expose only an explicitly configured local ZIP; no request controls its path. */
export function createDesktopDownload({ file = process.env.GLINT_DESKTOP_DOWNLOAD_FILE } = {}) {
  const validPath = typeof file === "string" && path.isAbsolute(file) && /\.zip$/i.test(file);

  function openArchive() {
    if (!validPath) return null;
    let fd;
    try {
      fd = fs.openSync(file, "r");
      const stat = fs.fstatSync(fd);
      const signature = Buffer.alloc(4);
      if (!stat.isFile() || stat.size < 4 || fs.readSync(fd, signature, 0, 4, 0) !== 4 || !signature.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
        fs.closeSync(fd); return null;
      }
      return { fd, size: stat.size };
    } catch {
      if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore close errors */ }
      return null;
    }
  }

  return {
    available() {
      const archive = openArchive();
      if (!archive) return false;
      fs.closeSync(archive.fd);
      return true;
    },
    handle(req, res) {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { allow: "GET, HEAD", "cache-control": "no-store" }); res.end(); return;
      }
      const archive = openArchive();
      if (!archive) { res.writeHead(404, { "cache-control": "no-store" }); res.end(); return; }
      res.writeHead(200, {
        "content-type": "application/zip",
        "content-length": archive.size,
        "content-disposition": 'attachment; filename="Glint-Windows.zip"',
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      if (req.method === "HEAD") { fs.closeSync(archive.fd); res.end(); return; }
      const stream = fs.createReadStream(null, { fd: archive.fd, autoClose: true, start: 0 });
      res.on("close", () => stream.destroy());
      stream.on("error", () => res.destroy());
      stream.pipe(res);
    },
  };
}
