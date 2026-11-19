import { expect, it } from "vitest";
import { executionFixture } from "./media-execution-fixture";
import { executionHost } from "./media-execution-host-fixture";
it("guards injected media jobs in the actual authenticated/base-path host", async () => {
  const f = await executionFixture(),
    host = await executionHost(f);
  try {
    expect((await host.request("execution/config", undefined, { authorization: "" })).status).toBe(
      401,
    );
    expect(
      (await host.request("execution/quote", f.input, { origin: "https://other.example" })).status,
    ).toBe(403);
    const denied = await host.request("submit", {
      ...f.input,
      bindingId: undefined,
      requestId: "no-confirm",
    });
    expect(denied.status).toBe(400);
    expect(f.submits).toBe(0);
    const quoteResponse = await host.request("execution/quote", f.input);
    expect(quoteResponse.status).toBe(200);
    const quote = await quoteResponse.json();
    expect(
      (
        await host.request("execution/approve", {
          quoteId: quote.id,
          requestId: "host",
          confirmed: true,
          capCny: 1,
        })
      ).status,
    ).toBe(200);
    const input = { ...f.input, requestId: "host", quoteId: quote.id };
    const submit = await host.request("execution/submit", input);
    expect(submit.status).toBe(202);
    const task = await submit.json();
    const status = await host.request(`execution/status/${task.taskId}`);
    expect((await status.json()).state).toBe("success");
    expect((await host.request("execution/submit", input)).status).toBe(202);
    expect((await host.request("execution/receipt/host")).status).toBe(200);
    expect((await host.request("execution/request/host")).status).toBe(200);
    expect(f.submits).toBe(1);
  } finally {
    await host.close();
    await f.close();
  }
});
