import type { PrevizDocument } from "../../../packages/previz/src/index";
/** Shared controls consume a draft adapter, never choose their own persistence mechanism. */
export type PrevizEditingState = {
  doc: PrevizDocument;
  shot: string;
  dirty: boolean;
  canMigrate?: boolean;
  change(
    kind: "camera" | "actor",
    id: string,
    field: "x" | "y" | "z" | "yaw" | "fov",
    value: string,
  ): void;
  update(transform: (doc: PrevizDocument) => PrevizDocument): void;
};
