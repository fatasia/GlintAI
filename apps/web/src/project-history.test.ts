import { describe, expect, it } from "vitest";
import { readSavedProjects, removeProject, saveProject } from "./project-history";

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

describe("project history", () => {
  it("keeps the newest project first and caps history", () => {
    const storage = memoryStorage();
    for (let index = 0; index < 22; index++) saveProject({ id: String(index), name: `P${index}`, mode: "source", text: "x", template: "explainer", theme: "glint-dark", aspect: "16:9" }, storage);
    const projects = readSavedProjects(storage);
    expect(projects).toHaveLength(20);
    expect(projects[0]?.id).toBe("21");
  });

  it("updates an existing project instead of duplicating it", () => {
    const storage = memoryStorage();
    saveProject({ id: "a", name: "old", mode: "idea", text: "one", template: "explainer", theme: "glint-dark", aspect: "1:1" }, storage);
    saveProject({ id: "a", name: "new", mode: "idea", text: "two", template: "explainer", theme: "glint-dark", aspect: "1:1" }, storage);
    expect(readSavedProjects(storage)).toHaveLength(1);
    expect(readSavedProjects(storage)[0]?.name).toBe("new");
  });

  it("removes a project", () => {
    const storage = memoryStorage();
    saveProject({ id: "a", name: "A", mode: "source", text: "x", template: "explainer", theme: "glint-dark", aspect: "16:9" }, storage);
    removeProject("a", storage);
    expect(readSavedProjects(storage)).toEqual([]);
  });
});
