import { parseProject } from "@glintai/scenescript";
import { parseRecipeInput, type RecipeInput } from "@glintai/composer/recipe-inputs";
const contents = {
  "source-explainer": { markdown: "# Observe water\n\n## State\nWater flows at room temperature." },
  "product-promo": {
    productName: "Test product",
    tagline: "Confirmed features",
    sellingPoints: ["One", "Two", "Three"],
    productImage: "photo",
  },
  "slides-video": {
    document: {
      id: "deck",
      title: "Deck",
      kind: "slides",
      updatedAt: 1,
      activePageId: "p1",
      pages: [{ id: "p1", title: "One", html: "<h1>One</h1>", notes: "Notes" }],
    },
    pageDurationMs: 1000,
  },
  "longform-clips": {
    video: "footage",
    windows: [{ id: "selected", title: "Window", startMs: 500, endMs: 1500 }],
  },
  "drama-two-shot": {
    title: "Two shots",
    shots: [
      { title: "First", narration: "Hello", image: "photo", audio: "speech" },
      { title: "Second", narration: "Welcome", image: "photo", audio: "speech" },
    ],
  },
  "localized-voice": {
    project: parseProject({
      id: "original",
      title: "Original",
      aspect: "16:9",
      schemaVersion: 1,
      language: "zh-CN",
      theme: "glint-dark",
      knowledgeSources: [],
      scenes: [
        {
          id: "scene",
          kind: "title",
          title: "原稿",
          narration: { text: "你好", durationMs: 1000 },
        },
      ],
    }),
    targetLanguage: "en-US",
    translations: [{ sceneId: "scene", text: "Hello" }],
  },
};
/** Protocol fixtures use synthetic streams, not generated footage or narration. */
export function recipeDescriptorFixture(recipeId: RecipeInput["recipeId"]): RecipeInput {
  const required: Record<RecipeInput["recipeId"], string[]> = {
    "source-explainer": [],
    "product-promo": ["photo"],
    "slides-video": [],
    "longform-clips": ["footage"],
    "drama-two-shot": ["photo", "speech"],
    "localized-voice": ["speech"],
  };
  return parseRecipeInput({
    format: "glint-recipe-input",
    version: 1,
    recipeId,
    visual: "existing",
    voice: "existing",
    assets: [
      { id: "photo", file: "image.png", kind: "image" },
      { id: "speech", file: "audio.wav", kind: "audio" },
      { id: "footage", file: "video.mp4", kind: "video" },
    ].filter((asset) => required[recipeId].includes(asset.id)),
    audio: recipeId === "localized-voice" ? [{ sceneIndex: 0, assetId: "speech" }] : [],
    content: structuredClone(contents[recipeId]),
  });
}
