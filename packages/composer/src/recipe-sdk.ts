import { parseRecipeInput, type RecipeId } from "./recipe-inputs";
export { RecipeInput, RecipeDesignDocument, parseRecipeInput } from "./recipe-inputs";
export type { RecipeId } from "./recipe-inputs";
export const RECIPE_DEFINITIONS: readonly { id: RecipeId; version: string; title: string }[] = [
  { id: "source-explainer", version: "2.0.0", title: "资料讲解" },
  { id: "product-promo", version: "2.0.0", title: "产品宣传" },
  { id: "slides-video", version: "2.0.0", title: "幻灯片转视频" },
  { id: "longform-clips", version: "2.0.0", title: "长视频切片" },
  { id: "drama-two-shot", version: "2.0.0", title: "短剧两镜" },
  { id: "localized-voice", version: "2.0.0", title: "本地化配音" },
];
export function listRecipes() {
  return RECIPE_DEFINITIONS.map((item) => ({ ...item }));
}
/** Data-only normalization. No file access, adapter imports or execution privileges. */
export function materializeRecipeInput(value: unknown) {
  return structuredClone(parseRecipeInput(value));
}
