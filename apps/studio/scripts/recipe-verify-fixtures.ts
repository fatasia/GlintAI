import fs from "node:fs";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { SapiTtsProvider } from "@glintai/tts";
import { parseProject } from "@glintai/scenescript";
import { parseRecipeInput } from "@glintai/composer/recipe-inputs";
function illustration(label: string, flip: boolean) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540"><rect width="960" height="540" fill="${flip ? "#ede7d9" : "#e4ede6"}"/><rect x="60" y="70" width="840" height="350" rx="24" fill="#fffdf7"/><circle cx="${flip ? 650 : 320}" cy="190" r="60" fill="#d99b75"/><path d="M${flip ? 540 : 210} 390v-90q110-80 220 0v90" fill="${flip ? "#c2563b" : "#315e55"}"/><rect x="410" y="280" width="150" height="95" rx="12" fill="#242928"/><path d="m565 300 65-32v115l-65-30" fill="#242928"/><circle cx="445" cy="245" r="34" fill="#242928"/><circle cx="515" cy="245" r="34" fill="#242928"/><text x="70" y="475" font-family="Arial" font-size="34" fill="#242928">${label}</text></svg>`;
}
export async function createRecipeVerificationAssets(directory: string) {
  fs.mkdirSync(directory);
  fs.mkdirSync(path.join(directory, "assets"));
  for (const [index, label] of ["The workshop is open.", "Let us make a film."].entries()) {
    const png = new Resvg(illustration(label, index === 1)).render().asPng();
    fs.writeFileSync(path.join(directory, "assets", "image-" + index + ".png"), png, {
      flag: "wx",
    });
    const voice = await new SapiTtsProvider().synthesize({ text: label });
    fs.writeFileSync(path.join(directory, "voice-" + index + ".wav"), voice.audio, { flag: "wx" });
  }
}
const source = parseProject({
  schemaVersion: 1,
  id: "source",
  title: "源稿",
  language: "zh-CN",
  aspect: "16:9",
  fps: 24,
  theme: "glint-dark",
  knowledgeSources: [],
  scenes: [
    {
      id: "hello",
      kind: "image",
      src: "assets/image-0.png",
      presentation: "showcase",
      caption: "The workshop",
      camera: { type: "push", intensity: 0.8 },
      narration: { text: "工作室开放了。", durationMs: 2000 },
    },
    {
      id: "invite",
      kind: "image",
      src: "assets/image-1.png",
      presentation: "showcase",
      caption: "The invitation",
      camera: { type: "pull", intensity: 0.8 },
      narration: { text: "一起来拍电影。", durationMs: 2000 },
    },
  ],
});
const pages = [
  {
    id: "one",
    title: "Make a film",
    notes: "The workshop is open.",
    html: '<html><body style="margin:0;background:#ede7d9;color:#263b34;font:64px Arial;padding:100px;box-sizing:border-box;width:1280px;height:720px"><p style="font-size:22px;letter-spacing:5px">A SMALL WORKSHOP</p><h1>Make a film.</h1><p style="font-size:32px">Keep the original. Edit the story.</p></body></html>',
  },
  {
    id: "two",
    title: "Keep it editable",
    notes: "Let us make a film.",
    html: '<html><body style="margin:0;background:#263b34;color:#ede7d9;font:64px Arial;padding:100px;box-sizing:border-box;width:1280px;height:720px"><p style="font-size:22px;letter-spacing:5px">ONE SHARED PROJECT</p><h1>Keep it editable.</h1><p style="font-size:32px">Pictures, words, timing and sound.</p></body></html>',
  },
];
const content: Record<string, unknown> = {
  "source-explainer": {
    markdown: "# Keep the original\n\n## Edit a copy\nChange one part at a time.",
  },
  "product-promo": {
    productName: "Camera illustration",
    tagline: "An authored test illustration",
    sellingPoints: ["Original PNG", "Editable captions", "Local rendering"],
    productImage: "photo-0",
  },
  "slides-video": {
    document: {
      id: "deck",
      title: "Workshop",
      kind: "slides",
      updatedAt: 1,
      pages,
      activePageId: "one",
    },
    pageDurationMs: 1200,
  },
  "longform-clips": {
    video: "source",
    windows: [{ id: "selected", title: "Selected source window", startMs: 1000, endMs: 8000 }],
  },
  "drama-two-shot": {
    title: "Illustrated meeting",
    shots: [
      {
        title: "The workshop",
        narration: "The workshop is open.",
        image: "photo-0",
        audio: "voice-0",
      },
      {
        title: "The invitation",
        narration: "Let us make a film.",
        image: "photo-1",
        audio: "voice-1",
      },
    ],
  },
  "localized-voice": {
    project: source,
    targetLanguage: "en-US",
    translations: [
      { sceneId: "hello", text: "The workshop is open." },
      { sceneId: "invite", text: "Let us make a film." },
    ],
  },
};
export function recipeVerificationInput(id: string) {
  const assets = [0, 1].flatMap((i) => [
    { id: "photo-" + i, file: "assets/image-" + i + ".png", kind: "image" },
    { id: "voice-" + i, file: "voice-" + i + ".wav", kind: "audio" },
  ]);
  return parseRecipeInput({
    format: "glint-recipe-input",
    version: 1,
    recipeId: id,
    visual: "existing",
    voice: "existing",
    assets:
      id === "longform-clips" ? [{ id: "source", file: "source.mp4", kind: "video" }] : assets,
    audio:
      id === "localized-voice"
        ? [
            { sceneIndex: 0, assetId: "voice-0" },
            { sceneIndex: 1, assetId: "voice-1" },
          ]
        : [],
    content: content[id],
  });
}
