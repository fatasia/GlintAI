// @vitest-environment jsdom
// OPS-10 理解反馈 UI：提交失败（响应丢失）后必须能用同一个 attemptId 重试，不产生重复计数。
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { UnderstandingCheck } from "./UnderstandingCheck";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const questions = [
  { id: "isolated", question: "熵不减少的条件是什么？", choices: ["任意系统", "孤立系统", "有生命的系统"], concept: "适用条件", source: "熵与生命" },
];
const graded = {
  correct: 1, total: 1,
  results: [{ id: "isolated", correct: true, explanation: "资料限定为孤立系统。", source: "熵与生命" }],
};
const stats = { attempts: 1, concepts: [{ concept: "适用条件", answered: 1, missed: 0 }], basis: "本机记录" };
const asJson = (value: unknown, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => value }) as unknown as Response;

let cleanup = () => {};
afterEach(() => { cleanup(); document.body.innerHTML = ""; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function mount() {
  const div = document.createElement("div"); document.body.appendChild(div);
  const root = createRoot(div);
  cleanup = () => act(() => root.unmount());
  await act(async () => root.render(createElement(UnderstandingCheck, { project: "entropy", cardStyle: {} })));
  const choose = async (index: number) => act(async () => {
    div.querySelectorAll<HTMLInputElement>(`input[name="isolated"]`)[index]!.click();
  });
  const submit = async () => act(async () => {
    [...div.querySelectorAll("button")].find((button) => button.textContent === "核对答案")!.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return { div, choose, submit };
}

it("提交失败后重试沿用同一 attemptId，结果只计一次", async () => {
  vi.spyOn(crypto, "randomUUID").mockReturnValue("11111111-2222-4333-8444-555555555555");
  const posts: Array<Record<string, unknown>> = [];
  let failing = true;
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
    const target = String(url);
    if (init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      if (failing) throw new TypeError("Failed to fetch");
      return asJson(graded);
    }
    return asJson(target.endsWith("/stats") ? stats : questions);
  }));
  const view = await mount();
  expect(view.div.textContent).toContain("熵不减少的条件是什么？");
  await view.choose(1);
  await view.submit();
  expect(view.div.textContent).toContain("提交未确认，可重试同一次作答。");
  failing = false;
  await view.submit();
  expect(view.div.textContent).toContain("答对 1 / 1");
  expect(view.div.textContent).toContain("本机作答记录 · 1 次");
  expect(posts).toHaveLength(2);
  expect(posts[0]?.attemptId).toBe("11111111-2222-4333-8444-555555555555");
  expect(posts[1]?.attemptId).toBe("11111111-2222-4333-8444-555555555555");
  expect(posts[1]).toEqual(posts[0]);
});

it("题目加载失败给出可重载的报错，不误报为提交失败", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
  const view = await mount();
  expect(view.div.textContent).toContain("检查题暂不可用，请重试。");
  expect(view.div.textContent).not.toContain("提交未确认");
});
