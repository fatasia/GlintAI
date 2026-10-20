import { expect, it } from "vitest";
import { parsePersonaPack } from "./personas";
it("imports a bounded local persona pack with unique ids", () => {
  const personas = [{ id: "new-reader", name: "新读者", prompt: "指出未解释的缩写。" }];
  expect(parsePersonaPack({ version: 1, personas })).toEqual(personas);
  expect(() => parsePersonaPack({ version: 1, personas: [...personas, ...personas] })).toThrow();
  expect(() => parsePersonaPack({ version: 1, personas: [{ ...personas[0], prompt: "x".repeat(3001) }] })).toThrow();
});
