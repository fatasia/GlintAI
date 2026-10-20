import { expect, it } from "vitest";
import { codePages } from "./CodeScene";
it("paginates long code without dropping characters", () => {
  const code = "abcdefghijklmnop\n中文代码也需要换行\nfinal";
  const pages = codePages(code, 8, 2);
  expect(pages.length).toBeGreaterThan(1);
  expect(pages.join("").replace(/\n/g, "")).toBe(code.replace(/\n/g, ""));
});
