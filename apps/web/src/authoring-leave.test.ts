import { afterEach, expect, it, vi } from "vitest";
import { assertAuthoringCanLeave, registerAuthoringLeaveGuard } from "./authoring-leave";
import { pendingDesignDrafts, pendingScriptDrafts } from "./authoring-drafts";

const releases: (() => void)[] = [];
afterEach(() => { releases.splice(0).forEach(release => release()); pendingDesignDrafts.clear(); pendingScriptDrafts.clear(); });
it("检查当前与目标工程的所有编辑器，不执行其他工程的检查", () => {
  const script = vi.fn(), design = vi.fn(), target = vi.fn(), unrelated = vi.fn();
  for (const [id, check] of [["a", script], ["a", design], ["b", target], ["c", unrelated]] as const)
    releases.push(registerAuthoringLeaveGuard(id, check));
  assertAuthoringCanLeave(["a", "b", "a"]);
  for (const check of [script, design, target]) expect(check).toHaveBeenCalledOnce();
  expect(unrelated).not.toHaveBeenCalled();
});
it("只读检查每次重新执行，拒绝时不注销或清理，卸载只移除自己的注册", () => {
  let dirty = false;
  const first = registerAuthoringLeaveGuard("a", () => { if (dirty) throw Error("尚有批注"); }); releases.push(first);
  const other = vi.fn(); releases.push(registerAuthoringLeaveGuard("a", other));
  assertAuthoringCanLeave(["a"]); dirty = true;
  expect(() => assertAuthoringCanLeave(["a"])).toThrow("尚有批注");
  expect(() => assertAuthoringCanLeave(["a"])).toThrow("尚有批注");
  first(); first(); assertAuthoringCanLeave(["a"]); expect(other).toHaveBeenCalledTimes(2);
});
it("未挂载目标的 pending 仍阻止离开，失败保留原引用", () => {
  const draft = { state: { version: 1 as const, projectId: "a", documents: [], activeId: "" }, raw: null, error: "quota" };
  pendingDesignDrafts.set("a", draft);
  expect(() => assertAuthoringCanLeave(["a"])).toThrow("未保存的脚本或设计草稿");
  expect(pendingDesignDrafts.get("a")).toBe(draft);
});
