import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  globalConfigHome,
  legacyStatePaths,
  statePath,
} from "@anthelia/platform";
import { z } from "zod";

/**
 * The interface-preference config (theme, keybinds, density, ...). Lived
 * inside the TUI app until the settings surface was made public; it now lives
 * here so the runtime can serve it over RPC and any consumer can read the
 * same schema the TUI renders.
 */
const keybindValue = z.union([
  z.string(),
  z.array(z.string()),
  z.literal(false),
]);

const keybindsSchema = z.record(keybindValue).default({});

export const tuiConfigSchema = z.object({
  version: z.literal(1).default(1),
  theme: z.string().default("natalia-dark"),
  themeMode: z.enum(["dark", "light", "system"]).default("dark"),
  keybinds: keybindsSchema,
  leaderKey: z.string().min(1).default("ctrl+x"),
  leaderTimeoutMs: z.number().int().positive().default(2000),
  toolDetails: z.enum(["collapsed", "expanded"]).default("collapsed"),
  reasoning: z.enum(["step", "hidden"]).default("step"),
  density: z.enum(["comfortable", "compact"]).default("comfortable"),
  followBottom: z.boolean().default(true),
  scrollSpeed: z.number().positive().default(1),
  scrollAcceleration: z.boolean().default(true),
  mouse: z.boolean().default(true),
  prompt: z
    .object({ maxHeight: z.number().int().min(1).max(24).default(8) })
    .default({}),
  diffStyle: z.enum(["auto", "stacked"]).default("auto"),
  attention: z
    .object({
      enabled: z.boolean().default(false),
      notifications: z.boolean().default(true),
      sound: z.boolean().default(false),
      volume: z.number().min(0).max(1).default(0.4),
    })
    .default({}),
});

export type TuiConfig = z.infer<typeof tuiConfigSchema>;
export type TuiConfigPatch = Partial<TuiConfig>;
export type TuiConfigWriteScope = "global" | "project";
export type TuiConfigSource = {
  scope: "defaults" | "global" | "project";
  path?: string;
  applied: boolean;
  diagnostic?: string;
};

export function tuiConfigPath(
  workspaceRoot: string,
  scope: TuiConfigWriteScope,
) {
  if (scope === "project")
    return resolve(workspaceRoot, ".natalia", "tui.json");
  // `resolve(process.env.HOME ?? "", ...)` collapsed to the *current directory*
  // on Windows, where HOME is normally unset. Global settings then silently
  // applied only inside whatever directory saved them, and Natalia scattered
  // `.config` trees into user repositories. globalConfigHome reproduces
  // `$HOME/.config` on POSIX and resolves `%APPDATA%` on Windows.
  return resolve(statePath(globalConfigHome(), "tui.json"));
}

export async function resolveTuiConfig(workspaceRoot: string): Promise<{
  config: TuiConfig;
  sources: TuiConfigSource[];
  projectPath: string;
}> {
  const projectPath = tuiConfigPath(workspaceRoot, "project");
  // The legacy `natalia-cli` location as the read fallback: an existing
  // install's TUI state is still honored. Writes go to the live name
  // (tuiConfigPath above), so the migration is one-way and silent-safe.
  const liveGlobalPath = tuiConfigPath(workspaceRoot, "global");
  const legacyGlobal = legacyStatePaths(globalConfigHome(), "tui.json").find(
    (candidate) => existsSync(candidate.path),
  );
  const globalPath =
    !existsSync(liveGlobalPath) && legacyGlobal
      ? legacyGlobal.path
      : liveGlobalPath;
  let config = tuiConfigSchema.parse({});
  const sources: TuiConfigSource[] = [{ scope: "defaults", applied: true }];
  for (const [scope, path] of [
    ["global", globalPath],
    ["project", projectPath],
  ] as const) {
    try {
      const raw = JSON.parse(
        await readFile(path, "utf8"),
      ) as Partial<TuiConfig>;
      config = tuiConfigSchema.parse({
        ...config,
        ...raw,
        prompt: { ...config.prompt, ...raw.prompt },
        attention: { ...config.attention, ...raw.attention },
        keybinds: { ...config.keybinds, ...raw.keybinds },
      });
      sources.push({ scope, path, applied: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        sources.push({ scope, path, applied: false, diagnostic: "missing" });
      else
        sources.push({
          scope,
          path,
          applied: false,
          diagnostic: error instanceof Error ? error.message : String(error),
        });
    }
  }
  return { config, sources, projectPath };
}

export async function saveTuiConfig(
  workspaceRoot: string,
  config: TuiConfigPatch,
  scope: TuiConfigWriteScope = "project",
) {
  const path = tuiConfigPath(workspaceRoot, scope);
  const parsed = tuiConfigSchema.deepPartial().parse(config);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${Date.now().toString(36)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, path);
}
