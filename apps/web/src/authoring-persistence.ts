/** Optional working buffer. Durable project writes still belong to the parent session. */
export type AuthoringPersistence = {
  storage: Pick<Storage, "getItem" | "setItem">;
  label: string;
  history: { canUndo: boolean; canRedo: boolean; undo(): void; redo(): void };
};
