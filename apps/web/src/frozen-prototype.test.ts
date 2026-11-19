import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { expect, it } from "vitest";
// @ts-expect-error build-time JavaScript plugin
import { frozenPrototypeCompatibility, transformFrozenPrototypeDependency } from "../build/frozen-prototype.mjs";

it("安装中的 Zod 3 在冻结原型下原本失败，兼容变换后保留校验语义且不取消冻结", () => {
  const require = createRequire(new URL("../../../../packages/scenescript/package.json", import.meta.url));
  const root = path.dirname(require.resolve("zod/package.json")), id = path.join(root, "v3/helpers/errorUtil.cjs"), original = fs.readFileSync(id, "utf8");
  const run = (code: string) => {
    const sandbox = { exports: {} as { errorUtil?: { toString(value: unknown): unknown; errToObj(value: unknown): unknown } } };
    vm.runInNewContext(`"use strict";Object.freeze(Object.prototype);${code};if (!Object.isFrozen(Object.prototype)) throw Error('prototype was unfrozen');`, sandbox);
    return sandbox.exports.errorUtil!;
  };
  expect(() => run(original)).toThrow(/read only|readonly/);
  const code = transformFrozenPrototypeDependency(original, id), util = run(code);
  expect(util.toString("原始错误")).toBe("原始错误"); expect(util.toString({ message: "结构错误" })).toBe("结构错误");
  expect(util.toString(undefined)).toBeUndefined(); expect(util.errToObj("必填")).toEqual({ message: "必填" });
  expect(frozenPrototypeCompatibility().transform(original, id)).toEqual({ code, map: null });
});

it("仅改指定 Zod namespace；上游实现变化时失败，不猜测性改写第三方代码", () => {
  const code = "errorUtil = {}";
  expect(transformFrozenPrototypeDependency(code, "C:\\deps\\zod\\v3\\helpers\\errorUtil.js")).toContain("Object.create(null)");
  expect(transformFrozenPrototypeDependency(code, "/zod/v3/helpers/errorUtil.js?used")).toContain("Object.create(null)");
  for (const id of ["/src/errorUtil.js", "/zod/v4/helpers/errorUtil.js", "/zod/v3/helpers/util.js"]) expect(transformFrozenPrototypeDependency(code, id)).toBeNull();
  expect(() => transformFrozenPrototypeDependency("changed implementation", "/zod/v3/helpers/errorUtil.js")).toThrow("changed");
});
