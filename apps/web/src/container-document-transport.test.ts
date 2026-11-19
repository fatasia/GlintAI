import { expect, it } from "vitest";
import { parseNleProject } from "@glintai/scenescript";
import { StudioSessionClient } from "./session-client";
import { createContainerDocumentTransport } from "./container-document-transport";

const document = parseNleProject({ schemaVersion: 1, id: "old-nle", title: "Timeline", fps: 30, width: 1920, height: 1080, tracks: [] });
type AppendBody = { projectId: string; transaction: { id: string }; changes: [{ objectId: string; versionId: string; payload: typeof document }] };
const binding = { projectId: "container", objectId: "timeline" };
const wrap = (payload = document, revision = 0, transactionId?: string) => ({
  snapshot: { projectId: "container", revision, document: { format: "glint-project", version: 1, id: "container",
    objects: [{ id: "timeline", kind: "timeline-document", currentVersionId: "v1" }], versions: [{ id: "v1", objectId: "timeline", payload }] } },
  look: { projectId: "container", revision, undoDepth: revision, redoDepth: 0, selection: [], digest: "fixture" },
  ...(transactionId ? { receipt: { transactionId, stage: "verified", revision } } : {}),
});
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

it("uses only GET to open and maps existing client updates to a pinned container append", async () => {
  const calls: Array<{ url: string; body: AppendBody | undefined }> = [];
  const transport = createContainerDocumentTransport(binding, parseNleProject, async (url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined; calls.push({ url, body });
    return Response.json(body ? wrap(body.changes[0].payload, 1, body.transaction.id) : wrap());
  });
  const client = new StudioSessionClient(document, () => {}, undefined, transport);
  await client.connect(); client.update({ ...document, title: "Edited" }); await settle();
  expect(calls[0]).toEqual({ url: "/api/project-containers/snapshot?projectId=container", body: undefined });
  expect(calls[1]!.body!.projectId).toBe("container");
  expect(calls[1]!.body!.changes[0]).toMatchObject({ objectId: "timeline", payload: { id: "old-nle", title: "Edited" } });
  expect(client.state()).toMatchObject({ status: "ready", dirty: false, project: { title: "Edited" } });
  client.dispose();
});

it("retains a conflict draft without auto-writing the remote projection", async () => {
  let writes = 0;
  const adapter = createContainerDocumentTransport(binding, parseNleProject, async (_url, init) => {
    if (!init) return Response.json(wrap());
    writes++; return Response.json(wrap({ ...document, title: "Remote" }, 1), { status: 409 });
  });
  const client = new StudioSessionClient(document, () => {}, undefined, adapter);
  await client.connect(); client.update({ ...document, title: "Draft" }); await settle();
  expect(client.state()).toMatchObject({ status: "conflict", dirty: true, project: { title: "Draft" }, remote: { title: "Remote" } });
  await client.poll(); expect(writes).toBe(1); client.dispose();
});

it("retries ambiguous saves with the same transaction and immutable version ID", async () => {
  const writes: AppendBody[] = [];
  const adapter = createContainerDocumentTransport(binding, parseNleProject, async (_url, init) => {
    if (!init) return Response.json(wrap());
    const body = JSON.parse(String(init.body)); writes.push(body);
    if (writes.length === 1) throw new Error("Lost response");
    return Response.json(wrap(body.changes[0].payload, 1, body.transaction.id));
  });
  const client = new StudioSessionClient(document, () => {}, undefined, adapter);
  await client.connect(); client.update({ ...document, title: "Draft" }); await settle();
  expect(client.state().status).toBe("error"); await client.retry();
  expect(writes[1]).toEqual(writes[0]); expect(client.state().dirty).toBe(false); client.dispose();
});

it("routes shared history and refuses old approval operations instead of forwarding them", async () => {
  const calls: string[] = [];
  const adapter = createContainerDocumentTransport(binding, parseNleProject, async (url, init) => {
    calls.push(url); const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (init) expect(body.projectId).toBe("container");
    return Response.json(wrap(document, body ? 1 : 0, body?.transactionId));
  });
  const client = new StudioSessionClient(document, () => {}, undefined, adapter);
  await client.connect(); await client.history("undo");
  expect(calls[1]).toBe("/api/project-containers/undo");
  expect(await client.approveCharacter("hero")).toBe(false);
  expect(calls).toHaveLength(2); client.dispose();
});

it("does not overwrite a newer snapshot on connect and rejects mismatched identities", async () => {
  let count = 0;
  const adapter = createContainerDocumentTransport(binding, parseNleProject, async () => { count++; return Response.json(wrap({ ...document, title: "Remote" }, 1)); });
  const client = new StudioSessionClient(document, () => {}, undefined, adapter);
  await client.connect(); expect(client.state().status).toBe("conflict"); expect(count).toBe(1); client.dispose();
  const wrong = createContainerDocumentTransport(binding, parseNleProject, async () => Response.json(wrap({ ...document, id: "other" })));
  await expect(wrong("snapshot", undefined, document)).rejects.toThrow(/identity/);
});

it("rejects a save receipt for a different transaction", async () => {
  const adapter = createContainerDocumentTransport(binding, parseNleProject, async (_url, init) => Response.json(init ? wrap(document, 1, "wrong") : wrap()));
  const client = new StudioSessionClient(document, () => {}, undefined, adapter);
  await client.connect(); client.update({ ...document, title: "Draft" }); await settle();
  expect(client.state()).toMatchObject({ status: "error", dirty: true }); client.dispose();
});

it("pins container identity even if a history caller supplies a document ID", async () => {
  for (const action of ["undo", "redo"]) {
    const adapter = createContainerDocumentTransport(binding, parseNleProject, async (_url, init) => {
      expect(JSON.parse(String(init?.body)).projectId).toBe("container");
      return Response.json(wrap(document, 1, "history"));
    });
    await adapter(action, { projectId: "old-nle", transactionId: "history", baseRevision: 0, actor: "user" }, document);
  }
});
