// @vitest-environment jsdom
// CORE-03 acceptance fixture: the Agent (EditorAssistant) edit entry lands in the
// SAME ProjectSession domain as manual edits — one revision line, one undo stack.
// Real component + real client + real ProjectSession; only the HTTP transport is local.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseProject, type SceneScriptProject } from "@glintai/scenescript";
import { ProjectSession } from "@glintai/session";
import { EditorAssistant } from "./EditorAssistant";
import { StudioSessionClient, type SessionView } from "./session-client";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const project = parseProject({ schemaVersion: 1, id: "core3", title: "Base", aspect: "16:9", knowledgeSources: [], scenes: [
  { id: "one", kind: "title", title: "One", narration: { text: "one", durationMs: 1000 } },
] });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };

/** Domain-backed session mock: receipts upgrade "dispatched"→"verified" exactly
 * like the node adapter's persistence readback; snapshot/look are POST-mutation
 * state, same as FileSessionStore.mutate. */
function domainServer() {
  const session = new ProjectSession(project.id, project, 0);
  const upgrade = (receipt: ReturnType<typeof session.submit>) => receipt.stage === "dispatched" ? { ...receipt, stage: "verified" as const } : receipt;
  return {
    session,
    handle: async (url: string, body: any) => {
      if (url.endsWith("/api/session/open")) return json({ snapshot: session.snapshot(), look: session.look() });
      if (url.endsWith("/api/session/apply")) {
        const receipt = upgrade(session.submit(body.transaction));
        return json({ snapshot: session.snapshot(), look: session.look(), receipt });
      }
      if (url.endsWith("/api/session/undo") || url.endsWith("/api/session/redo")) {
        const receipt = upgrade(session.historyEdit(url.endsWith("/undo") ? "undo" : "redo", body.transactionId, body.baseRevision, body.actor));
        return json({ snapshot: session.snapshot(), look: session.look(), receipt });
      }
      throw new Error(`unexpected session route ${url}`);
    },
  };
}

describe("CORE-03 agent edits share the manual session domain", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => { for (const off of cleanups.splice(0)) off(); document.body.innerHTML = ""; vi.unstubAllGlobals(); });

  it("AI edit is one undoable transaction on the same revision line as manual edits", async () => {
    const server = domainServer();
    const calls: Array<{ url: string; body: any }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      const target = String(url), body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: target, body });
      if (target.endsWith("/api/assistant/plan")) return json({ steps: [] });
      if (target.endsWith("/api/edit-scene")) {
        const edited = structuredClone((body as { project: SceneScriptProject }).project);
        (edited.scenes[0] as { title: string }).title = "AI Cut";
        return json({ project: edited });
      }
      return server.handle(target, body);
    }));
    const views: SessionView[] = [];
    const client = new StudioSessionClient(project, view => views.push(view));
    await client.connect();
    expect(client.state()).toMatchObject({ status: "ready" });
    expect(server.session.look()).toMatchObject({ revision: 0, undoDepth: 0 });

    // Manual edit first: user transaction, revision 1.
    const manual = structuredClone(project); manual.title = "Manual";
    client.update(manual);
    await settle();
    expect(client.state()).toMatchObject({ status: "ready", dirty: false });
    expect(server.session.look()).toMatchObject({ revision: 1, undoDepth: 1 });

    // Agent edit through the real component, wired exactly like SessionEditor
    // (SceneEditor commit "product-agent" → client.update meta).
    const div = document.createElement("div"); document.body.appendChild(div);
    const root = createRoot(div); cleanups.push(() => act(() => root.unmount()));
    const renderWith = (value: SceneScriptProject) => act(async () => root.render(createElement(EditorAssistant, {
      project: value, sceneId: "one", onChange: next => client.update(next, { actor: "product-agent", intent: "AI 助手修改分镜" }),
    })));
    await renderWith(client.state().project);
    const input = div.querySelector<HTMLTextAreaElement>('[aria-label="分镜修改指令"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "改成 AI Cut");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => [...div.querySelectorAll("button")].find(button => button.textContent === "AI 修改本分镜")!.click());
    await settle();

    // Same revision line: the agent transaction bases on the manual revision.
    const applies = calls.filter(call => call.url.endsWith("/api/session/apply"));
    expect(applies).toHaveLength(2);
    expect(applies.map(call => ({ tx: call.body.transaction }))).toMatchObject([
      { tx: { actor: "user", intent: "Studio 编辑", baseRevision: 0 } },
      { tx: { actor: "product-agent", intent: "AI 助手修改分镜", baseRevision: 1 } },
    ]);
    expect(server.session.look()).toMatchObject({ revision: 2, undoDepth: 2 });
    expect((client.state().project.scenes[0] as { title: string }).title).toBe("AI Cut");
    expect(client.state().receipt).toMatchObject({ stage: "verified", revision: 2, baseRevision: 1 });

    // Undo removes the agent edit and ONLY the agent edit; redo restores it.
    await client.history("undo");
    await settle();
    expect(server.session.look()).toMatchObject({ revision: 3, undoDepth: 1, redoDepth: 1 });
    expect(client.state().project.title).toBe("Manual");
    expect((client.state().project.scenes[0] as { title: string }).title).toBe("One");
    await client.history("redo");
    await settle();
    expect(server.session.look()).toMatchObject({ revision: 4, undoDepth: 2, redoDepth: 0 });
    expect((client.state().project.scenes[0] as { title: string }).title).toBe("AI Cut");
    const undos = calls.filter(call => call.url.endsWith("/api/session/undo"));
    expect(undos).toHaveLength(1);
    expect(undos[0]!.body).toMatchObject({ actor: "user", baseRevision: 2 });
  });

  it("a plain manual update after an agent update is not mislabeled", async () => {
    const server = domainServer();
    const calls: Array<{ url: string; body: any }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      const target = String(url), body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: target, body });
      if (target.includes("/api/session/")) return server.handle(target, body);
      throw new Error(`unexpected fetch ${target}`);
    }));
    const client = new StudioSessionClient(project, () => {});
    await client.connect();
    const agent = structuredClone(project); (agent.scenes[0] as { title: string }).title = "AI Cut";
    client.update(agent, { actor: "product-agent" });
    await settle();
    const manual = structuredClone(agent); manual.title = "Second";
    client.update(manual);
    await settle();
    const last = calls.filter(call => call.url.endsWith("/api/session/apply")).at(-1)!;
    expect(last.body.transaction).toMatchObject({ actor: "user", intent: "Studio 编辑", baseRevision: 1 });
    expect(server.session.look()).toMatchObject({ revision: 2, undoDepth: 2 });
  });
});
