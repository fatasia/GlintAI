import { describe, expect, it } from "vitest";
import { DESIGN_ANNOTATION_LIMIT, validateDesignDocuments, type ProjectDesignDocuments } from "./design-artifacts";
import { DESIGN_BRIDGE, readDesignBridgeMessage } from "./design-editor-bridge";

const base = (annotations?: unknown): ProjectDesignDocuments => ({
  version: 1, projectId: "p", activeId: "d1",
  documents: [{ id: "d1", title: "页面", kind: "page", activePageId: "g1", updatedAt: 1,
    pages: [{ id: "g1", title: "首页", html: "<main data-design-id=\"hero\">你好</main>", ...(annotations === undefined ? {} : { annotations: annotations as never }) }] }],
});

describe("page annotations data contract", () => {
  it("keeps a valid pin and rejects out-of-range coordinates", () => {
    const state = base([{ id: "a1", x: 12.5, y: 88, text: "标题再大一点", nodeId: "hero", createdAt: 2 }]);
    expect(validateDesignDocuments(state, "p").documents[0]!.pages[0]!.annotations).toHaveLength(1);
    expect(() => validateDesignDocuments(base([{ id: "a1", x: 101, y: 10, text: "越界", createdAt: 2 }]), "p")).toThrow();
    expect(() => validateDesignDocuments(base([{ id: "a1", x: 10, y: -1, text: "越界", createdAt: 2 }]), "p")).toThrow();
  });

  it("rejects duplicate ids, empty text overflow and forged node ids", () => {
    const mark = { id: "a1", x: 10, y: 10, text: "说明", createdAt: 1 };
    expect(() => validateDesignDocuments(base([mark, { ...mark }]), "p")).toThrow();
    expect(() => validateDesignDocuments(base([{ ...mark, text: "x".repeat(2001) }]), "p")).toThrow();
    expect(() => validateDesignDocuments(base([{ ...mark, nodeId: "bad id!" }]), "p")).toThrow();
    expect(() => validateDesignDocuments(base(Array.from({ length: DESIGN_ANNOTATION_LIMIT + 1 }, (_, index) => ({ ...mark, id: `a${index}` }))), "p")).toThrow();
  });

  it("still accepts pages without annotations (older documents keep loading)", () => {
    expect(validateDesignDocuments(base(), "p").documents[0]!.pages[0]!.annotations).toBeUndefined();
  });
});

describe("preview bridge comment channel", () => {
  const frame = {} as Window;
  const event = (data: unknown) => ({ source: frame, data } as unknown as MessageEvent);

  it("accepts a comment click with percentage coordinates", () => {
    const message = readDesignBridgeMessage(event({ type: DESIGN_BRIDGE, generation: "g", action: "comment", x: 42.5, y: 7, nodeId: "hero", text: "这里" }), frame, "g");
    expect(message).toMatchObject({ action: "comment", x: 42.5, y: 7, nodeId: "hero" });
  });

  it("drops comments without usable coordinates and keeps other actions working", () => {
    expect(readDesignBridgeMessage(event({ type: DESIGN_BRIDGE, generation: "g", action: "comment", x: 140, y: 10 }), frame, "g")).toBeUndefined();
    expect(readDesignBridgeMessage(event({ type: DESIGN_BRIDGE, generation: "g", action: "comment", x: 10 }), frame, "g")).toBeUndefined();
    expect(readDesignBridgeMessage(event({ type: DESIGN_BRIDGE, generation: "g", action: "ready" }), frame, "g")).toMatchObject({ action: "ready" });
  });

  it("ignores messages from another window or generation", () => {
    expect(readDesignBridgeMessage(event({ type: DESIGN_BRIDGE, generation: "g", action: "comment", x: 10, y: 10 }), {} as Window, "g")).toBeUndefined();
    expect(readDesignBridgeMessage(event({ type: DESIGN_BRIDGE, generation: "other", action: "comment", x: 10, y: 10 }), frame, "g")).toBeUndefined();
  });
});
