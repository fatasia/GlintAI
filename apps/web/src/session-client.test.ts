// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseProject, type SceneScriptProject } from "@glintai/scenescript";
import { StudioSessionClient, type SessionView } from "./session-client";

const project = parseProject({
  schemaVersion: 1, id: "cas-demo", title: "CAS", aspect: "16:9", knowledgeSources: [],
  scenes: [{ id: "one", kind: "title", title: "One", narration: { text: "one", durationMs: 1000 } }],
});
const look = (revision: number, undoDepth = 0, redoDepth = 0) => ({ revision, undoDepth, redoDepth, selection: [] });
const snapshot = (document: SceneScriptProject = project, revision = 1) => ({ snapshot: { document, revision }, look: look(revision) });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Fetch stub scripted per-URL; records bodies for transaction-id assertions. */
function scriptFetch(handlers: Array<{ match: (url: string) => boolean; reply: (url: string, body: unknown) => Response }>) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    const handler = handlers.find(entry => entry.match(url));
    if (!handler) throw new Error(`unexpected fetch ${url}`);
    return handler.reply(url, body);
  });
  vi.stubGlobal("fetch", fetcher);
  return { calls, fetcher };
}

const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); };
const lastView = (view: SessionView) => view;

afterEach(() => { vi.unstubAllGlobals(); });

describe("StudioSessionClient CAS protocol (CORE-02)", () => {
  it("connects, applies a diff and adopts the server snapshot on success", async () => {
    const { calls } = scriptFetch([
      { match: url => url.endsWith("/open"), reply: () => json({ ...snapshot(project, 3), receipt: { stage: "saved", revision: 3, baseRevision: 2, reason: "" } }) },
      { match: url => url.endsWith("/apply"), reply: (_url, body) => {
        const next = structuredClone(project); (next.scenes[0] as { title: string }).title = "Two";
        return json({ ...snapshot(next, 4), receipt: { stage: "verified", revision: 4, baseRevision: (body as { transaction: { baseRevision: number } }).transaction.baseRevision, reason: "" } });
      } },
    ]);
    const views: SessionView[] = [];
    const client = new StudioSessionClient(project, view => views.push(view));
    await client.connect();
    expect(client.state()).toMatchObject({ status: "ready", message: "共享工程 · r3" });
    const edited = structuredClone(project); (edited.scenes[0] as { title: string }).title = "Two";
    client.update(edited);
    await settle();
    expect(client.state()).toMatchObject({ status: "ready", dirty: false });
    const appliedScene = client.state().project.scenes[0]!;
    expect(appliedScene.kind === "title" && appliedScene.title).toBe("Two");
    expect(client.state().receipt?.stage).toBe("verified");
    const applied = calls.find(call => call.url.endsWith("/apply"))!;
    expect((applied.body as { transaction: { baseRevision: number } }).transaction.baseRevision).toBe(3);
    expect(lastView(views[views.length - 1]!).status).toBe("ready");
  });

  it("retries an ambiguous failure with the SAME transaction id and adopts the saved draft", async () => {
    let attempts = 0;
    const next = structuredClone(project); (next.scenes[0] as { title: string }).title = "Retried";
    const { calls } = scriptFetch([
      { match: url => url.endsWith("/open"), reply: () => json(snapshot(project, 2)) },
      { match: url => url.endsWith("/apply"), reply: () => {
        attempts += 1;
        if (attempts === 1) return json({ error: "boom" }, 500);
        return json({ ...snapshot(next, 3), receipt: { stage: "saved", revision: 3, baseRevision: 2, reason: "" } });
      } },
    ]);
    const client = new StudioSessionClient(project, () => {});
    await client.connect();
    client.update(next);
    await settle();
    expect(client.state().status).toBe("error");
    await client.retry();
    expect(client.state()).toMatchObject({ status: "ready", dirty: false });
    expect(attempts).toBe(2);
    const applies = calls.filter(call => call.url.endsWith("/apply"));
    expect(applies).toHaveLength(2);
    expect((applies[0]!.body as { transaction: { id: string } }).transaction.id)
      .toBe((applies[1]!.body as { transaction: { id: string } }).transaction.id);
  });

  it("surfaces a 409 conflict with the remote snapshot and keeps the local draft", async () => {
    const remote = structuredClone(project); (remote.scenes[0] as { title: string }).title = "Remote";
    const local = structuredClone(project); (local.scenes[0] as { title: string }).title = "Local";
    scriptFetch([
      { match: url => url.endsWith("/open"), reply: () => json(snapshot(project, 5)) },
      { match: url => url.endsWith("/apply"), reply: () => json({ ...snapshot(remote, 6), look: look(6), receipt: { stage: "refused", revision: 6, baseRevision: 5, reason: "其他入口已修改" } }, 409) },
      { match: url => url.includes("/snapshot"), reply: () => json({ ...snapshot(remote, 6), look: look(6) }) },
    ]);
    const client = new StudioSessionClient(project, () => {});
    await client.connect();
    client.update(local);
    await settle();
    expect(client.state()).toMatchObject({ status: "conflict", dirty: true });
    const remoteScene = client.state().remote?.scenes[0]!;
    expect(remoteScene?.kind === "title" && remoteScene.title).toBe("Remote");
    // Local draft untouched; reload adopts the shared version.
    const localDraft = client.state().project.scenes[0]!;
    expect(localDraft.kind === "title" && localDraft.title).toBe("Local");
    await client.reload();
    expect(client.state()).toMatchObject({ status: "ready", dirty: false });
    const sharedScene = client.state().project.scenes[0]!;
    expect(sharedScene.kind === "title" && sharedScene.title).toBe("Remote");
  });

  it("keeps polling inert while a transaction is in flight, then takes the 409", async () => {
    const local = structuredClone(project); (local.scenes[0] as { title: string }).title = "Local";
    const remote = structuredClone(project); (remote.scenes[0] as { title: string }).title = "Remote";
    let releaseApply!: (response: Response) => void;
    const gate = new Promise<Response>(resolve => { releaseApply = resolve; });
    const { fetcher } = scriptFetch([
      { match: url => url.endsWith("/open"), reply: () => json(snapshot(project, 1)) },
      { match: url => url.endsWith("/apply"), reply: () => gate as unknown as Response },
    ]);
    const client = new StudioSessionClient(project, () => {});
    await client.connect();
    client.update(local);
    await settle();
    // In flight: a poll tick must not fire a second request.
    await client.poll();
    expect(fetcher).toHaveBeenCalledTimes(2);
    releaseApply(json({ ...snapshot(remote, 2), look: look(2), receipt: { stage: "refused", revision: 2, baseRevision: 1, reason: "其他入口已修改" } }, 409));
    await settle();
    expect(client.state()).toMatchObject({ status: "conflict", dirty: true });
    const draftScene = client.state().project.scenes[0]!;
    expect(draftScene.kind === "title" && draftScene.title).toBe("Local");
  });
});

describe("TEAM-09 approval freeze (owner-only single-operation)", () => {
  it("freezes and unfreezes through single-operation user transactions", async () => {
    let revision = 3;
    let frozen: boolean | undefined;
    const doc = () => (frozen === undefined ? project : { ...project, frozen });
    const { calls } = scriptFetch([
      { match: url => url.endsWith("/open"), reply: () => json({ snapshot: { document: doc(), revision }, look: look(revision) }) },
      { match: url => url.endsWith("/apply"), reply: (_url, body) => {
        const tx = (body as { transaction: { operations: Array<{ value: boolean | undefined }> } }).transaction;
        frozen = tx.operations[0]!.value;
        revision += 1;
        return json({ snapshot: { document: doc(), revision }, look: look(revision), receipt: { stage: "verified", revision, baseRevision: revision - 1, reason: "" } });
      } },
    ]);
    const client = new StudioSessionClient(project, () => {});
    await client.connect();
    await client.setFrozen(true);
    await client.setFrozen(false);
    const applies = calls.filter(call => call.url.endsWith("/apply"));
    expect(applies).toHaveLength(2);
    const txOf = (call: { body: unknown }) => (call.body as { transaction: { actor: string; baseRevision: number; operations: unknown[] } }).transaction;
    expect(txOf(applies[0]!)).toMatchObject({ actor: "user", baseRevision: 3, operations: [{ kind: "set", path: ["frozen"], value: true }] });
    expect(txOf(applies[1]!)).toMatchObject({ actor: "user", baseRevision: 4, operations: [{ kind: "set", path: ["frozen"], value: false }] });
    expect(client.state()).toMatchObject({ status: "ready", dirty: false });
    expect(client.state().project.frozen).toBe(false);
  });

  it("never toggles the freeze from a conflicted or dirty state, so no bundled diff reaches the server", async () => {
    const remote = { ...project, frozen: true } as SceneScriptProject;
    const local = structuredClone(project); (local.scenes[0] as { title: string }).title = "Local";
    const { calls } = scriptFetch([
      { match: url => url.endsWith("/open"), reply: () => json(snapshot(project, 5)) },
      { match: url => url.endsWith("/apply"), reply: () => json({ ...snapshot(remote, 6), receipt: { stage: "refused", revision: 6, baseRevision: 5, reason: "Project is frozen for approval; only the owner can unfreeze it" } }, 409) },
    ]);
    const client = new StudioSessionClient(project, () => {});
    await client.connect();
    client.update(local); // 与冻结中的共享版本相撞 → 409 conflict
    await settle();
    expect(client.state().status).toBe("conflict");
    await client.setFrozen(false);
    expect(calls.filter(call => call.url.endsWith("/apply"))).toHaveLength(1); // 冻结切换自身未发请求
    expect(client.state().project.frozen).toBeUndefined();
    expect(client.state().message).toContain("frozen");
  });
});

it("recovers an ambiguous character approval with the same transaction ID", async () => {
  const draft = parseProject({ ...project, assets: [{ id: "hero", kind: "character", name: "小雨", version: "v1", description: "蓝外套", voice: "voice-a", refs: ["assets/hero.png"] }] });
  const hash = "a".repeat(64), refs = [`assets/approved-${hash}.png`], asset = draft.assets![0]!;
  const approved = parseProject({ ...draft, assets: [{ ...asset, refs, approval: { version: asset.version, name: asset.name, description: asset.description, voice: asset.voice, refs, refSha256: hash } }] });
  let attempts = 0;
  const { calls } = scriptFetch([
    { match: url => url.endsWith("/open"), reply: () => json(snapshot(draft, 3)) },
    { match: url => url.endsWith("/approve-character"), reply: () => ++attempts === 1 ? json({ error: "lost reply" }, 500) : json({ ...snapshot(approved, 4), receipt: { stage: "verified", revision: 4, baseRevision: 3 } }) },
  ]);
  const client = new StudioSessionClient(draft, () => {}); await client.connect();
  expect(await client.approveCharacter("hero")).toBe(false); expect(client.state().status).toBe("error");
  await client.retry(); expect(client.state().project.assets![0]!.approval?.refSha256).toBe(hash);
  const approvals = calls.filter(call => call.url.endsWith("/approve-character"));
  expect(approvals).toHaveLength(2);
  expect((approvals[0]!.body as { transactionId: string }).transactionId).toBe((approvals[1]!.body as { transactionId: string }).transactionId);
});

it("preserves concurrent local edits when a server-side approval commits", async () => {
  const draft = parseProject({ ...project, assets: [{ id: "hero", kind: "character", name: "小雨", version: "v1", description: "蓝外套", voice: "voice-a", refs: ["assets/hero.png"] }] });
  const hash = "a".repeat(64), refs = [`assets/approved-${hash}.png`], asset = draft.assets![0]!;
  const approved = parseProject({ ...draft, assets: [{ ...asset, refs, approval: { version: asset.version, name: asset.name, description: asset.description, voice: asset.voice, refs, refSha256: hash } }] });
  let resolve!: (response: Response) => void;
  const transport = vi.fn((url: string) => url.endsWith("/open") ? Promise.resolve(json(snapshot(draft, 3))) : new Promise<Response>(done => { resolve = done; }));
  const client = new StudioSessionClient(draft, () => {}, transport); await client.connect();
  const pending = client.approveCharacter("hero"); client.update({ ...draft, title: "本地新标题" });
  resolve(json({ ...snapshot(approved, 4), receipt: { stage: "verified", revision: 4, baseRevision: 3 } }));
  expect(await pending).toBe(false); expect(client.state()).toMatchObject({ status: "conflict", project: { title: "本地新标题" } });
  expect(client.state().remote?.assets?.[0]?.approval?.refSha256).toBe(hash); expect(transport).toHaveBeenCalledTimes(2);
});


it.each(["undo", "redo"] as const)("preserves concurrent typing and the remote %s result without a follow-up patch", async action => {
  const remote = { ...project, title: `shared ${action}` };
  const local = { ...project, scenes: [{ ...project.scenes[0]!, title: "typed while waiting" }] } as SceneScriptProject;
  let release!: (response: Response) => void;
  const transport = vi.fn((url: string) => url.endsWith("/open")
    ? Promise.resolve(json({ ...snapshot(project, 3), look: look(3, 1, 1) }))
    : new Promise<Response>(resolve => { release = resolve; }));
  const client = new StudioSessionClient(project, () => {}, transport);
  await client.connect();
  const pending = client.history(action);
  client.update(local);
  release(json({ ...snapshot(remote, 4), receipt: { stage: "saved", revision: 4, baseRevision: 3 } }));
  await pending;
  expect(client.state()).toMatchObject({ status: "conflict", project: local, remote, dirty: true, receipt: { revision: 4 } });
  expect(transport).toHaveBeenCalledTimes(2);
  client.dispose();
});

it.each(["undo", "redo"] as const)("retries an ambiguous %s using the same transaction while preserving later edits", async action => {
  let attempt = 0, release!: (response: Response) => void;
  const remote = { ...project, title: "history result" }, local = { ...project, title: "local edit" };
  const calls: Array<{ transactionId: string }> = [];
  const transport = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/open")) return json({ ...snapshot(project, 1), look: look(1, 1, 1) });
    calls.push(JSON.parse(String(init?.body)));
    if (++attempt === 1) return json({ error: "receipt lost" }, 500);
    return new Promise<Response>(resolve => { release = resolve; });
  });
  const client = new StudioSessionClient(project, () => {}, transport); await client.connect();
  await client.history(action); expect(client.state().status).toBe("error");
  client.update(local); const retry = client.retry();
  release(json({ ...snapshot(remote, 2), receipt: { stage: "saved", revision: 2, baseRevision: 1 } })); await retry;
  expect(calls[0]!.transactionId).toBe(calls[1]!.transactionId);
  expect(client.state()).toMatchObject({ status: "conflict", project: local, remote });
  expect(calls).toHaveLength(2); client.dispose();
});

it.each(["undo", "redo"] as const)("adopts the %s result normally when no edit races it", async action => {
  const remote = { ...project, title: "history result" };
  const client = new StudioSessionClient(project, () => {}, async url => url.endsWith("/open")
    ? json({ ...snapshot(project, 1), look: look(1, 1, 1) })
    : json({ ...snapshot(remote, 2), receipt: { stage: "saved", revision: 2, baseRevision: 1 } }));
  await client.connect(); await client.history(action);
  expect(client.state()).toMatchObject({ status: "ready", project: remote, dirty: false }); client.dispose();
});

it("keeps edits made during reload and invalidates an older poll", async () => {
  const remote = { ...project, title: "shared" }, local = { ...project, title: "new local" };
  const gates: Array<(response: Response) => void> = [];
  const transport = vi.fn((url: string) => url.endsWith("/open")
    ? Promise.resolve(json(snapshot(project, 1)))
    : new Promise<Response>(resolve => gates.push(resolve)));
  const client = new StudioSessionClient(project, () => {}, transport); await client.connect();
  const poll = client.poll();
  const reload = client.reload();
  client.update(local);
  gates[1]!(json(snapshot(remote, 2))); await reload;
  expect(client.state()).toMatchObject({ status: "conflict", project: local, remote, dirty: true });
  gates[0]!(json(snapshot({ ...project, title: "stale" }, 3))); await poll;
  expect(client.state()).toMatchObject({ status: "conflict", project: local, remote });
  const second = client.reload(); gates[2]!(json(snapshot(remote, 2))); await second;
  expect(client.state()).toMatchObject({ status: "ready", project: remote, dirty: false });
  client.dispose();
});

it("keeps the local draft when reload fails or is disposed", async () => {
  let release!: (response: Response) => void;
  const transport = vi.fn((url: string) => url.endsWith("/open") ? Promise.resolve(json(snapshot(project, 1))) : new Promise<Response>(resolve => { release = resolve; }));
  const client = new StudioSessionClient(project, () => {}, transport); await client.connect();
  const local = { ...project, title: "draft" };
  const read = client.reload(); client.update(local); release(json({ error: "offline" }, 500)); await read;
  expect(client.state()).toMatchObject({ status: "error", project: local });
  const second = client.reload(); client.dispose(); release(json(snapshot({ ...project, title: "shared" }, 2))); await second;
  expect(client.state().project).toEqual(local);
});

it("retries an ambiguous product approval with the same transaction", async () => {
  const draft = parseProject({ ...project, assets: [{ id: "item", kind: "product", name: "商品", version: "v1", description: "红色", refs: ["assets/item.png"] }] });
  const hash = "d".repeat(64), refs = [`assets/approved-${hash}.png`], asset = draft.assets![0]!;
  const approved = parseProject({ ...draft, assets: [{ ...asset, refs, approval: { version: asset.version, name: asset.name, description: asset.description, refs, refSha256: hash } }] });
  let attempts = 0;
  const { calls } = scriptFetch([{ match: url => url.endsWith("/open"), reply: () => json(snapshot(draft, 3)) }, { match: url => url.endsWith("/approve-product"), reply: () => ++attempts === 1 ? json({ error: "lost reply" }, 500) : json({ ...snapshot(approved, 4), receipt: { stage: "verified", revision: 4, baseRevision: 3 } }) }]);
  const client = new StudioSessionClient(draft, () => {}); await client.connect();
  expect(await client.approveProduct("item")).toBe(false); await client.retry();
  expect(client.state().project.assets![0]!.approval?.refSha256).toBe(hash);
  const approvals = calls.filter(call => call.url.endsWith("/approve-product")); expect(approvals).toHaveLength(2);
  expect((approvals[0]!.body as { transactionId: string }).transactionId).toBe((approvals[1]!.body as { transactionId: string }).transactionId);
});
