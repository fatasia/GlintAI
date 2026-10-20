import { expect, it } from "vitest";
import { PERSONA_CATALOG, parsePersonaCatalog } from "./catalog";
it("validates built-ins and strips unrecognized executable metadata", () => {
  expect(parsePersonaCatalog(PERSONA_CATALOG).entries).toHaveLength(3);
  const value = JSON.parse(JSON.stringify(PERSONA_CATALOG));
  value.entries[0].script = "anything";
  expect(parsePersonaCatalog(value).entries[0]).not.toHaveProperty("script");
});
it("rejects duplicate ids, bad versions and unbounded prompts", () => {
  for (const edit of [
    (x: any) => x.entries.push(x.entries[0]),
    (x: any) => (x.entries[0].version = "latest"),
    (x: any) => (x.entries[0].personas[0].prompt = "x".repeat(3001)),
  ]) {
    const x = structuredClone(PERSONA_CATALOG);
    edit(x);
    expect(() => parsePersonaCatalog(x)).toThrow();
  }
});
