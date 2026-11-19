import path from "node:path";
import { readLocal } from "./recipe-files";
import { recipeFileHash } from "./recipe-assets";
type Artifact = { file: string; sha256: string; bytes: number };
/** Validate previous-stage typed files before handing them to the original exporter/QA. */
export function verifyRecipeReceipt(
  directory: string,
  receiptFile: string,
  expected: string[],
  inputDigest: string,
  key: "files" | "outputs",
) {
  const receipt = JSON.parse(readLocal(path.join(directory, receiptFile)));
  const files: Artifact[] = receipt?.[key];
  if (
    receipt?.version !== 1 ||
    receipt?.inputDigest !== inputDigest ||
    !Array.isArray(files) ||
    files.length !== expected.length
  )
    throw new Error("Recipe artifact receipt does not match approved input");
  for (const [index, file] of files.entries()) {
    if (file?.file !== expected[index]) throw new Error("Recipe artifact path or order changed");
    const actual = recipeFileHash(path.join(directory, file.file));
    if (file.sha256 !== actual.sha256 || file.bytes !== actual.bytes)
      throw new Error("Recipe artifact changed: " + file.file);
  }
}
