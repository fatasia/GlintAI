import os from "node:os";
import path from "node:path";

/** Resolve only; existing settings stores handle writes outside the repository by default. */
export function modelSettingsFile(kind: "llm" | "media", { env = process.env, platform = process.platform, homeDir = os.homedir() }: {
  env?: Record<string, string | undefined>; platform?: NodeJS.Platform; homeDir?: string;
} = {}): string {
  const paths = platform === "win32" ? path.win32 : path.posix;
  if (env.GLINT_DATA_DIR) return paths.join(env.GLINT_DATA_DIR, `${kind}-settings.json`);
  if (!paths.isAbsolute(homeDir)) throw new Error("Cannot determine an absolute user configuration directory");
  if (platform === "darwin") return paths.join(homeDir, "Library", "Application Support", "Glint", "web", `${kind}-settings.json`);
  const configured = platform === "win32" ? env.LOCALAPPDATA : env.XDG_CONFIG_HOME;
  const fallback = platform === "win32" ? paths.join(homeDir, "AppData", "Local") : paths.join(homeDir, ".config");
  const root = configured && paths.isAbsolute(configured) ? configured : fallback;
  return paths.join(root, platform === "win32" ? "Glint" : "glint", "web", `${kind}-settings.json`);
}
