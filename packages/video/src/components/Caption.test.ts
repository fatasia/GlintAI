import { expect, it } from "vitest";
import { captionPage } from "./Caption";
it("pages long captions by time and keeps the last page at the end", () => {
  const words = Array.from({ length: 100 }, (_, i) => ({ text: "字", startMs: i * 100, endMs: (i + 1) * 100 }));
  expect(captionPage(words, 0, 30)).toHaveLength(30);
  expect(captionPage(words, 3100, 30)[0]!.startMs).toBe(3000);
  expect(captionPage(words, 99999, 30)).toHaveLength(10);
});
