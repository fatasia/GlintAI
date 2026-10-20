import { expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { RenderSession } from "./render-session";
it("owns an isolated public/bundle root and safely cleans unused sessions twice", async () => {
  const session = new RenderSession();
  const root = path.dirname(session.publicDir);
  expect(path.dirname(root)).toBe(path.resolve(os.tmpdir()));
  expect(path.basename(root)).toMatch(/^glint-session-/);
  fs.writeFileSync(path.join(session.publicDir, "only-this-job.txt"), "temporary");
  await session.dispose();
  expect(fs.existsSync(root)).toBe(false);
  await expect(session.dispose()).resolves.toBeUndefined();
});
