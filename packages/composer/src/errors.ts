export class ComposerError extends Error {
  constructor(message: string) { super(message); this.name = "ComposerError"; }
}
