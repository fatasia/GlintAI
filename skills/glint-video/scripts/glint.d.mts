export interface RuntimeOptions {
  root?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  entryUrl?: string;
}
export function resolveRuntime(options?: RuntimeOptions): string;
export function invocation(argv: string[], options?: Omit<RuntimeOptions, "root">): {
  runtime: "source" | "portable";
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
};
