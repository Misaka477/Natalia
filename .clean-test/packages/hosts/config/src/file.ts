import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  copyFile,
  open,
  rename,
  rm,
} from "node:fs/promises";
import { dirname } from "node:path";
import { configV3Schema, type ConfigV3 } from "@anthelia/contracts";
import {
  migrateConfig,
  migrationSummaryText,
  type MigrationResult,
} from "./migration";
import { defaultConfigV3 } from "./migration";

export async function loadConfigFile(path: string): Promise<MigrationResult> {
  const raw = await readFile(path, "utf8");
  const data = parseConfigText(raw);
  return migrateConfig(data);
}

export async function loadOrCreateConfigFile(path: string) {
  try {
    return await loadConfigFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const config = defaultConfigV3();
    await saveConfigFile(config, path);
    return {
      config,
      summary: {
        fromVersion: 3 as const,
        toVersion: 3 as const,
        changed: ["created default TS config"],
        warnings: [],
      },
    };
  }
}

export async function saveConfigFile(config: ConfigV3, path: string) {
  const parsed = configV3Schema.parse(config);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, {
      mode: 0o600,
    });
    const handle = await open(temporary, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/** Persists a validated scope overlay without promoting resolved values. */
export async function saveConfigOverlayFile(path: string, overlay: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(overlay, null, 2)}\n`, {
      mode: 0o600,
    });
    const handle = await open(temporary, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function migrateConfigFile(path: string, now = new Date()) {
  const raw = await readFile(path, "utf8");
  const data = parseConfigText(raw);
  const result = migrateConfig(data);
  if (result.summary.fromVersion !== 3 || result.summary.changed.length) {
    const backupPath = `${path}.bak.${now.toISOString().replace(/[:.]/g, "-")}`;
    await copyFile(path, backupPath);
    result.summary.backupPath = backupPath;
    await saveConfigFile(result.config, path);
  }
  return { ...result, text: migrationSummaryText(result.summary) };
}

export function parseConfigText(raw: string) {
  // A UTF-8 BOM from a Windows editor makes JSON.parse throw and also defeats
  // the `^\s*[\[{]` guard below, so a valid config would silently fall through
  // to the legacy YAML reader and parse into garbage. POSIX files have no BOM.
  const text = raw.replace(/^\uFEFF/u, "");
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (/^\s*[\[{]/u.test(text)) throw error;
    return parseLegacyYamlSubset(text);
  }
}

function parseLegacyYamlSubset(raw: string) {
  const root: Record<string, unknown> = {};
  const stack: Array<{ indent: number; value: Record<string, unknown> }> = [
    { indent: -1, value: root },
  ];
  for (const line of raw.split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indent = line.match(/^\s*/u)?.[0].length ?? 0;
    const match = line.trim().match(/^([^:]+):(.*)$/u);
    if (!match) continue;
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent)
      stack.pop();
    const parent = stack[stack.length - 1].value;
    const key = match[1].trim();
    const rawValue = match[2].trim();
    if (!rawValue) {
      const child: Record<string, unknown> = {};
      parent[key] = child;
      stack.push({ indent, value: child });
      continue;
    }
    parent[key] = parseScalar(rawValue);
  }
  return root;
}

function parseScalar(value: string) {
  const unquoted = value.replace(/^['"]|['"]$/gu, "");
  if (/^-?\d+$/u.test(unquoted)) return Number(unquoted);
  if (unquoted === "true") return true;
  if (unquoted === "false") return false;
  if (unquoted === "null") return null;
  return unquoted;
}
