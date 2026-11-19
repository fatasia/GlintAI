import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { executionFixture, approveFixture, mediaModel, pixel } from "./media-execution-fixture";

describe.each(["fal", "replicate"])("bound %s media execution", (provider) => {
  it("binds explicit credentials, approves, submits once and imports real decodable output", async () => {
    const f = await executionFixture(provider);
    try {
      const config = await f.service.config();
      expect(JSON.stringify(config)).not.toContain("fixture-credential");
      expect(config.bindings[0].ready).toBe(true);
      const input = await approveFixture(f, "first");
      const task = await f.service.submit(input);
      expect(await f.service.submit(input)).toEqual(task);
      const status = await f.service.status(task.taskId);
      expect(status.state).toBe("success");
      expect(status.costUnit).toBe("unknown");
      expect(await fs.readFile(path.join(f.root, status.assetUrl.split("/").pop()))).toEqual(pixel);
      expect((await f.service.quotes.receipt("first")).quote.unit).toBe("CNY");
      expect(f.submits).toBe(1);
      expect((await f.service.quotes.receipt("first")).observed.amount).toBeNull();
    } finally {
      await f.close();
    }
  });
  it("does not resubmit lost POSTs, even after recovery", async () => {
    const f = await executionFixture(provider);
    try {
      f.disconnect();
      const input = await approveFixture(f, "lost");
      const task = await f.service.submit(input);
      expect(task.state).toBe("unconfirmed");
      expect(await f.service.request("lost")).toEqual({ taskId: task.taskId });
      expect((await f.service.status(task.taskId)).state).toBe("unconfirmed");
      await f.service.submit(input);
      expect(f.submits).toBe(1);
    } finally {
      await f.close();
    }
  });
  it("retries downloads without new execution and reports actual upstream cancellation", async () => {
    const f = await executionFixture(provider);
    try {
      const task = await f.service.submit(await approveFixture(f, "download"));
      f.failDownload(true);
      await expect(f.service.status(task.taskId)).rejects.toThrow("fixture download disconnected");
      f.failDownload(false);
      expect((await f.service.status(task.taskId)).state).toBe("success");
      const cancelTask = await f.service.submit(await approveFixture(f, "cancel"));
      expect((await f.service.cancel(cancelTask.taskId)).state).toBe("cancelled");
      expect(f.submits).toBe(2);
    } finally {
      await f.close();
    }
  });
});
it("rejects unapproved direct calls, input changes, expired or reused approvals", async () => {
  const f = await executionFixture();
  try {
    await expect(f.service.submit({ ...f.input, requestId: "no-approval" })).rejects.toThrow(
      "approval-required",
    );
    const input = await approveFixture(f, "changed");
    await expect(f.service.submit({ ...input, prompt: "changed" })).rejects.toThrow(
      "quote-changed",
    );
    const quote = await f.service.quotes.quote(f.input);
    await f.service.quotes.approve({
      quoteId: quote.id,
      requestId: "one",
      confirmed: true,
      capCny: 1,
    });
    await expect(
      f.service.quotes.approve({ quoteId: quote.id, requestId: "two", confirmed: true, capCny: 1 }),
    ).rejects.toThrow("quote-consumed");
    expect(f.submits).toBe(0);
  } finally {
    await f.close();
  }
});
it("invalidates changed model/account bindings; unknown units never become free", async () => {
  const f = await executionFixture();
  try {
    await f.registry.replace(
      { models: [mediaModel("fal", { basis: "unknown" })] },
      (await f.registry.read()).digest,
    );
    await expect(f.service.quotes.quote(f.input)).rejects.toThrow("binding-changed");
    await f.service.bindings.save({ id: "bound", modelId: "test-fal", accountId: "account" });
    await expect(f.service.quotes.quote(f.input)).rejects.toThrow("unknown-cost");
    await f.service.accounts.save({
      id: "account",
      provider: "fal",
      token: "new-fixture-credential",
    });
    expect((await f.service.bindings.list())[0].ready).toBe(false);
    expect(f.submits).toBe(0);
  } finally {
    await f.close();
  }
});
it("uses a filesystem lock for competing approval reservations and retains uncertain spend", async () => {
  const f = await executionFixture();
  try {
    const first = await f.service.quotes.quote(f.input),
      second = await f.service.quotes.quote(f.input);
    const results = await Promise.allSettled(
      [first, second].map((quote, index) =>
        f.service.quotes.approve({
          quoteId: quote.id,
          requestId: `r${index}`,
          capCny: 0.01,
          confirmed: true,
        }),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(
      f.service.quotes.approve({
        quoteId: second.id,
        requestId: "third",
        capCny: 0,
        confirmed: true,
      }),
    ).rejects.toThrow();
  } finally {
    await f.close();
  }
});
it("installs guards on both legacy gateway and local workflow entry points", async () => {
  const f = await executionFixture();
  try {
    await expect(
      f.jobs.submit({ ...f.input, bindingId: undefined, requestId: "direct" }),
    ).rejects.toThrow("binding-required");
    const input = await approveFixture(f, "wrong-route");
    await expect(f.jobs.submit(input)).rejects.toThrow("adapter-route-mismatch");
    f.jobs.comfyui.configure({ endpoint: f.origin });
    await expect(
      f.jobs.comfyui.submit({
        requestId: "comfy",
        type: "image",
        workflow: { "1": { class_type: "EmptyLatentImage", inputs: {} } },
        confirmed: true,
      }),
    ).rejects.toThrow("binding-required");
    expect(f.submits).toBe(0);
    expect((await f.service.quotes.receipt("wrong-route")).attempt.state).toBe("approved");
  } finally {
    await f.close();
  }
});
it("refuses expired confirmation and stale fixed-file locks without a new POST", async () => {
  const f = await executionFixture();
  try {
    const input = await approveFixture(f, "expired");
    f.service.quotes.now = () => Date.now() + 6 * 60 * 1000;
    await expect(f.service.submit(input)).rejects.toThrow("quote-changed");
    const lock = path.join(f.root, "media-execution-associations.json.lock");
    await fs.writeFile(lock, "held-by-other-process", { flag: "wx" });
    await expect(f.service.quotes.quote(f.input)).rejects.toThrow("busy");
    expect(await fs.readFile(lock, "utf8")).toBe("held-by-other-process");
    expect(f.submits).toBe(0);
  } finally {
    await f.close();
  }
});
