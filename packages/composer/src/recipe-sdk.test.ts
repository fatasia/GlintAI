import { expect, it } from "vitest";
import { listRecipes, materializeRecipeInput } from "./recipe-sdk";
const input = {
  format: "glint-recipe-input",
  version: 1,
  recipeId: "source-explainer",
  visual: "mg",
  voice: "existing",
  assets: [],
  content: { markdown: "# Own notes\n\nFacts only" },
};
it("lists six built-in data adapters without executing a plugin", () => {
  expect(listRecipes()).toHaveLength(6);
  expect(new Set(listRecipes().map((item) => item.id)).size).toBe(6);
  expect(materializeRecipeInput(input).recipeId).toBe("source-explainer");
});
it("rejects arbitrary effects and unsafe asset paths", () => {
  for (const extension of [
    { steps: [] },
    { shell: "exec" },
    { quote: { amount: 0 } },
    { apiKey: "secret" },
  ])
    expect(() => materializeRecipeInput({ ...input, ...extension })).toThrow();
  for (const file of ["../private.wav", "/absolute.wav", "C:/private.wav", "sub/../../private.wav"])
    expect(() =>
      materializeRecipeInput({ ...input, assets: [{ id: "voice", file, kind: "audio" }] }),
    ).toThrow();
});
it("retains choices without mutating the descriptor", () => {
  const data = { ...input, visual: "aigc", voice: "sapi" },
    value = materializeRecipeInput(data);
  expect(value.visual).toBe("aigc");
  expect(value.voice).toBe("sapi");
  expect(data).not.toHaveProperty("audio");
});
it("validates static design identities and rejects executable slide conversion", () => {
  const document = {
    id: "deck",
    title: "Deck",
    kind: "slides",
    updatedAt: 1,
    activePageId: "page",
    pages: [{ id: "page", title: "Page", html: "<h1>Page</h1>" }],
  };
  const slides = {
    ...input,
    recipeId: "slides-video",
    content: { document, pageDurationMs: 1000 },
  };
  expect(materializeRecipeInput(slides).recipeId).toBe("slides-video");
  for (const html of [
    "<script>fetch('/private')</script>",
    "<iframe src='/private'></iframe>",
    "<div style='animation:slide 1s'>Page</div>",
  ])
    expect(() =>
      materializeRecipeInput({
        ...slides,
        content: {
          ...slides.content,
          document: { ...document, pages: [{ ...document.pages[0], html }] },
        },
      }),
    ).toThrow("static pages");
  expect(() =>
    materializeRecipeInput({
      ...slides,
      content: { ...slides.content, document: { ...document, activePageId: "missing" } },
    }),
  ).toThrow("active page");
  expect(() =>
    materializeRecipeInput({
      ...slides,
      content: {
        ...slides.content,
        document: { ...document, pages: [document.pages[0], document.pages[0]] },
      },
    }),
  ).toThrow("unique");
});
