/** Zod 3's namespace shadows Object.prototype.toString by assignment. Tauri
 * freezes that prototype first: give this namespace no inherited properties.
 * Keep the prototype freeze and the upstream validation behavior.
 */
export function transformFrozenPrototypeDependency(code, id) {
  if (!/\/zod\/v3\/helpers\/errorUtil\.(?:c?js|mjs)$/.test(id.replaceAll("\\", "/").split("?")[0])) return null;
  const expected = "errorUtil = {}";
  if (!code.includes(expected)) throw new Error("Zod errorUtil changed; review frozen-prototype compatibility before building the desktop UI.");
  return code.replaceAll(expected, "errorUtil = Object.create(null)");
}

export function frozenPrototypeCompatibility() {
  return {
    name: "glint-frozen-prototype-dependencies",
    enforce: "pre",
    transform(code, id) {
      const transformed = transformFrozenPrototypeDependency(code, id);
      return transformed === null ? null : { code: transformed, map: null };
    },
  };
}
