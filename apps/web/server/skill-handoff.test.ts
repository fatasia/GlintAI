import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parseProject } from "@glintai/scenescript";
import { FileSessionStore } from "@glintai/session/node";
import { runCreationPacks } from "../../studio/scripts/creation-packs-cli";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

/** A Skill writes plain SceneScript; the software must open it and hand it back as a pack. */
it("opens a Skill-written project in the shared session and returns it as a reusable pack", () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-handoff-")); roots.push(root);
  const skillProject = path.join(root, "skill-project.json"), exported = path.join(root, "pack.json"), reused = path.join(root, "reused.json");
  fs.writeFileSync(skillProject, JSON.stringify({
    schemaVersion: 1, id: "skill-made", title: "Skill 作品", aspect: "9:16", knowledgeSources: [],
    scenes: [
      { id: "hook", kind: "title", title: "开场钩子", narration: { text: "第一镜", durationMs: 1500 } },
      { id: "proof", kind: "bullets", heading: "证据", items: ["一", "二"], narration: { text: "第二镜", durationMs: 2200 } },
    ],
  }));
  const store = new FileSessionStore(path.join(root, "sessions"), document => { parseProject(document); });
  store.open("skill-made", JSON.parse(fs.readFileSync(skillProject, "utf8")));
  const opened = store.snapshot("skill-made").snapshot.document;
  expect(opened.title).toBe("Skill 作品");
  expect(opened.scenes).toHaveLength(2);
  expect(store.list()[0]!.projectId).toBe("skill-made");

  fs.writeFileSync(path.join(root, "software.json"), JSON.stringify(opened));
  runCreationPacks([`--export-project=${path.join(root, "software.json")}`, `--out=${exported}`, "--author=Skill owner", "--license=Personal only", "--confirm-rights"]);
  runCreationPacks([`--source=${exported}`, `--out=${reused}`]);
  const roundtrip = parseProject(JSON.parse(fs.readFileSync(reused, "utf8")));
  expect(roundtrip.scenes.map(scene => scene.id)).toEqual(["hook", "proof"]);
  expect(roundtrip.title).toBe("Skill 作品");
  expect(roundtrip.creationPack).toMatchObject({ id: expect.stringMatching(/^creation-/), version: "1.0.0" });
  expect(roundtrip.id).not.toBe("skill-made");
});
