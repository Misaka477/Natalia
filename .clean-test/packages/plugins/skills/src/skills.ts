import {
  cp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { validateSkillProposal } from "./skill-write";
import { createHash } from "node:crypto";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { profileShellCommand } from "@anthelia/platform";
import type { RuntimeTool, ToolExecutionContext } from "@anthelia/tools";
import type {
  SkillMetadata,
  SkillPolicy,
  SkillService,
} from "@anthelia/runtime-services";

export type Skill = SkillMetadata;

/**
 * The workspace's durable "these skills are off" set, as a sibling of the
 * skills directory itself. A disabled skill is still discovered and listed —
 * the settings panel shows it with its switch off — but `resolve` refuses it,
 * so the model can neither load nor run it.
 */
function disabledSkillsPath(workspaceRoot: string): string {
  return join(resolve(workspaceRoot), ".natalia", "skills-disabled.json");
}

async function readDisabledSkills(workspaceRoot: string): Promise<Set<string>> {
  try {
    const raw = JSON.parse(
      await readFile(disabledSkillsPath(workspaceRoot), "utf8"),
    ) as unknown;
    return new Set(
      Array.isArray(raw)
        ? raw.filter((name): name is string => typeof name === "string")
        : [],
    );
  } catch {
    // Absent (the common case) or unreadable: nothing is disabled. A corrupt
    // file must not take every skill down with it.
    return new Set();
  }
}

async function writeDisabledSkills(
  workspaceRoot: string,
  names: Set<string>,
): Promise<void> {
  const path = disabledSkillsPath(workspaceRoot);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // Written atomically: a half-written set would silently disable skills.
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify([...names].sort(), null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temp, path);
}

/**
 * An integrity failure (a declared digest did not match the bytes) is not
 * a transient fetch failure: it never degrades silently, even with a
 * cached skill present. The pull's catch keeps the old skill for network
 * failures; this error class is the one it re-throws unconditionally —
 * availability over alerting is the network's rule, never integrity's.
 */
export class RemoteSkillIntegrityError extends Error {}

/**
 * A skill file's content identity: the sha256 of its exact bytes. The
 * fingerprint catalog's atom (cua's model: every file carries its digest,
 * the client verifies before use) — local discovery stamps it, a remote
 * index's declaration is verified against it.
 */
export function skillDigest(content: string | Uint8Array): string {
  return createHash("sha256")
    .update(
      typeof content === "string" ? Buffer.from(content, "utf8") : content,
    )
    .digest("hex");
}

export type SkillDiscoverInput = {
  workspaceRoot: string;
  userRoot?: string;
  remoteURLs?: string[];
  cacheRoot?: string;
  fetch?: typeof fetch;
  /**
   * The loaded plugins' declared skills directories (absolute). Walked
   * FIRST so a project or user root with the same name overrides the
   * package's (the same precedence the other sources enjoy).
   */
  pluginDirs?: readonly string[];
};

export class SkillRegistry implements SkillService {
  private skills = new Map<string, Skill>();
  private selected = new Map<string, Skill>();
  /**
   * Stamped by discoverSkills so a validated write knows which project
   * root it belongs to and reload() can rebuild from the SAME roots
   * (reload replaces the sets — reloading with fewer roots would
   * silently forget user/remote skills).
   */
  origin?: SkillDiscoverInput;
  /** The workspace's durable off-switch, stamped onto every discovered skill. */
  disabled: Set<string> = new Set();

  register(skill: Skill) {
    if (this.skills.has(skill.qualifiedName))
      throw new Error(`duplicate skill: ${skill.qualifiedName}`);
    this.skills.set(skill.qualifiedName, skill);
    // Sources are applied in order; later user/project sources override names.
    this.selected.set(skill.name, skill);
  }

  resolve(name: string) {
    const direct = this.skills.get(name);
    const skill = direct ?? this.selected.get(name);
    if (!skill) throw new Error(`skill not found: ${name}`);
    // A disabled skill is listed, not usable: the model's load and the tool's
    // authorize both go through resolve, so one refusal covers both.
    if (!skill.enabled)
      throw new Error(
        `skill is disabled: ${name} (enable it in the settings panel)`,
      );
    return skill;
  }

  list() {
    return [...this.skills.values()].sort((a, b) =>
      a.qualifiedName.localeCompare(b.qualifiedName),
    );
  }

  /**
   * The ONLY autonomous write path (Discovery D4): a background review
   * PROPOSES, this VALIDATES at the boundary (action whitelist + name +
   * size + rebuilt frontmatter), writes under the project skills root
   * (0700/0600), then reloads so the registry sees it immediately.
   * hermes' rule: autonomous maintenance never bypasses validation.
   */
  async upsertSkill(
    candidate: unknown,
  ): Promise<{ created: boolean; name: string }> {
    const validated = validateSkillProposal(candidate);
    if (!validated.ok)
      throw new Error(`skill proposal rejected: ${validated.reason}`);
    if (!this.origin?.workspaceRoot)
      throw new Error("skill registry has no workspace origin");
    const { proposal, skillmd } = validated;
    const existed = this.selected.has(proposal.name);
    const target = join(
      resolve(this.origin.workspaceRoot),
      ".natalia",
      "skills",
      proposal.name,
    );
    await mkdir(target, { recursive: true, mode: 0o700 });
    await writeFile(join(target, "SKILL.md"), skillmd, { mode: 0o600 });
    await this.reload(this.origin);
    return { created: !existed, name: proposal.name };
  }

  async setSkillEnabled(
    name: string,
    enabled: boolean,
  ): Promise<{ name: string }> {
    if (!this.origin?.workspaceRoot)
      throw new Error("skill registry has no workspace origin");
    if (![...this.skills.values()].some((skill) => skill.name === name))
      throw new Error(`skill not found: ${name}`);
    const next = new Set(this.disabled);
    if (enabled) next.delete(name);
    else next.add(name);
    await writeDisabledSkills(this.origin.workspaceRoot, next);
    await this.reload(this.origin);
    return { name };
  }

  async removeSkill(name: string): Promise<{ removed: string }> {
    const skill = [...this.skills.values()].find((item) => item.name === name);
    if (!skill) throw new Error(`skill not found: ${name}`);
    // Only a workspace-owned skill can be removed: a plugin's skill ships with
    // the plugin and a remote one is pulled into a cache, so deleting either
    // would be undone by the next reload (or would corrupt the plugin).
    if (skill.source !== "project" && skill.source !== "user")
      throw new Error(
        `cannot remove a ${skill.source} skill: it ships with its ${skill.source} source`,
      );
    await rm(skill.root, { recursive: true, force: true });
    if (this.origin) await this.reload(this.origin);
    return { removed: name };
  }

  async reload(input: {
    workspaceRoot: string;
    userRoot?: string;
    remoteURLs?: string[];
    cacheRoot?: string;
    fetch?: typeof fetch;
    pluginDirs?: readonly string[];
  }) {
    const next = await discoverSkills(input);
    this.skills = next.skills;
    this.selected = next.selected;
    // The origin is what the write faces need, and reload IS the discovery
    // operation — a registry built by reload must be as usable as one built by
    // discoverSkills, or its writes have no root to write to.
    this.origin = { ...input };
    this.disabled = next.disabled;
  }

  authorizeTool(skill: Skill, tool: string, policy: SkillPolicy) {
    return authorizeSkillTool(skill, tool, policy);
  }

  async readResource(skill: Skill, path: string) {
    return await readSkillResource(skill, path);
  }

  async runScript(
    skill: Skill,
    name: string,
    input: { signal?: AbortSignal } = {},
  ) {
    return await runSkillScript(skill, name, input);
  }
}

export async function discoverSkills(input: SkillDiscoverInput) {
  const registry = new SkillRegistry();
  for (const dir of input.pluginDirs ?? [])
    await discoverRoot(registry, resolve(dir), "plugin");
  for (const url of input.remoteURLs ?? []) {
    const roots = await pullRemoteSkills({
      url,
      cacheRoot:
        input.cacheRoot ??
        join(resolve(input.workspaceRoot), ".natalia", "cache", "skills"),
      fetch: input.fetch,
    });
    for (const root of roots) await discoverSkillRoot(registry, root, "remote");
  }
  if (input.userRoot)
    await discoverRoot(registry, resolve(input.userRoot), "user");
  await discoverRoot(
    registry,
    join(resolve(input.workspaceRoot), ".natalia", "skills"),
    "project",
  );
  registry.origin = { ...input };
  // The switch: whatever the workspace turned off reads disabled, while staying
  // listed so the panel can switch it back on.
  const disabled = await readDisabledSkills(input.workspaceRoot);
  registry.disabled = disabled;
  for (const skill of registry.list())
    skill.enabled = !disabled.has(skill.name);
  return registry;
}

export function parseSkill(
  content: string,
  input: { root: string; source: "project" | "user" | "remote" | "plugin" },
) {
  // Windows editors and PowerShell's `Set-Content -Encoding UTF8` prepend a
  // UTF-8 BOM, which would keep `^---` from matching and surface only as
  // "requires YAML frontmatter delimiters". POSIX files carry no BOM, so
  // stripping one is a no-op there.
  const text = content.replace(/^\uFEFF/u, "");
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u);
  if (!match) throw new Error("SKILL.md requires YAML frontmatter delimiters");
  const frontmatter = parseFrontmatter(match[1]!);
  const name = required(frontmatter.name, "name");
  const description = required(frontmatter.description, "description");
  validateName(name);
  return {
    qualifiedName: `${input.source}:${name}`,
    name,
    // Enabled unless the workspace's disabled set says otherwise; discoverSkills
    // narrows it after reading the set.
    enabled: true,
    description,
    allowedTools: listValue(frontmatter["allowed-tools"]),
    requireApproval: boolValue(frontmatter["require-approval"]),
    sandboxRequired: boolValue(frontmatter["sandbox-required"]),
    scripts: recordValue(frontmatter.scripts),
    resources: listValue(frontmatter.resources),
    root: resolve(input.root),
    body: match[2]!.trim(),
    source: input.source,
    digest: skillDigest(content),
  } satisfies Skill;
}

export function authorizeSkillTool(
  skill: Skill,
  tool: string,
  policy: SkillPolicy,
) {
  if (policy.mode === "restricted") return false;
  if (policy.allowedTools && !policy.allowedTools.includes(tool)) return false;
  if (skill.allowedTools.length && !skill.allowedTools.includes(tool))
    return false;
  if (policy.mode === "sandbox" && !skill.sandboxRequired) return false;
  return true;
}

export function resolveSkillResource(skill: Skill, path: string) {
  if (isAbsolute(path)) throw new Error("skill resource must be relative");
  const target = resolve(skill.root, path);
  const rel = relative(skill.root, target);
  if (rel.startsWith("..") || isAbsolute(rel))
    throw new Error("skill resource escapes root");
  return target;
}

export async function readSkillResource(skill: Skill, path: string) {
  return await readFile(resolveSkillResource(skill, path), "utf8");
}

export async function formatSkillForModel(skill: Skill) {
  const files = (
    await readdir(skill.root, { recursive: true }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    })
  )
    .filter((path) => path !== "SKILL.md")
    .sort()
    .slice(0, 10)
    // `readdir` yields host separators. Every shell the model reaches is
    // bash-compatible, so a backslash path would be unusable there; POSIX
    // output is unchanged because it has no backslashes to replace.
    .map((path) => path.replaceAll("\\", "/"));
  return [
    `<skill_content name="${skill.name}">`,
    `# Skill: ${skill.name}`,
    "",
    skill.body,
    "",
    `Base directory for this skill: ${skill.root}`,
    "Relative paths in this skill are relative to this base directory.",
    "Note: file list is sampled.",
    "",
    "<skill_files>",
    ...files.map((file) => `<file>${file}</file>`),
    "</skill_files>",
    "</skill_content>",
  ].join("\n");
}

export function createSkillLoadTool(options: {
  registry: () => SkillRegistry | undefined;
  onLoad?: (
    skill: Skill,
    output: string,
    context: ToolExecutionContext,
  ) => void;
}): RuntimeTool {
  return {
    name: "skill_load",
    description: "Load a discovered local skill into the current conversation.",
    requiresApproval: true,
    parameters: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
    async execute(input, context) {
      if (!input || typeof input !== "object" || Array.isArray(input))
        throw new Error("skill_load arguments must be an object");
      const name = (input as Record<string, unknown>).name;
      if (typeof name !== "string")
        throw new Error("skill_load.name must be a string");
      const registry = options.registry();
      if (!registry) throw new Error("skill registry is not initialized");
      const skill = registry.resolve(name);
      const output = await formatSkillForModel(skill);
      options.onLoad?.(skill, output, context);
      return output;
    },
  };
}

export async function runSkillScript(
  skill: Skill,
  name: string,
  input: { signal?: AbortSignal } = {},
) {
  const command = skill.scripts[name];
  if (!command) throw new Error(`skill script not found: ${name}`);
  const shell = profileShellCommand(command, {
    posixShell: process.env.SHELL ?? "/usr/bin/bash",
  });
  const child = Bun.spawn([shell.executable, ...shell.args], {
    cwd: skill.root,
    stdout: "pipe",
    stderr: "pipe",
    env: safeSkillEnv(globalThis.process.env),
    signal: input.signal,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return {
    exitCode,
    stdout: stdout.slice(0, 12000),
    stderr: stderr.slice(0, 12000),
  };
}

async function discoverRoot(
  registry: SkillRegistry,
  root: string,
  source: "project" | "user" | "remote" | "plugin",
) {
  const entries = await readSkillDirectories(root);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillRoot = join(root, entry.name);
    try {
      registry.register(
        parseSkill(await readFile(join(skillRoot, "SKILL.md"), "utf8"), {
          root: skillRoot,
          source,
        }),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
}

async function discoverSkillRoot(
  registry: SkillRegistry,
  root: string,
  source: "project" | "user" | "remote",
) {
  registry.register(
    parseSkill(await readFile(join(root, "SKILL.md"), "utf8"), {
      root,
      source,
    }),
  );
}

export async function pullRemoteSkills(input: {
  url: string;
  cacheRoot: string;
  fetch?: typeof fetch;
}) {
  const base = new URL(input.url.endsWith("/") ? input.url : `${input.url}/`);
  if (!/^https?:$/u.test(base.protocol))
    throw new Error("remote skill URL must use HTTP or HTTPS");
  const fetchImpl = input.fetch ?? fetch;
  const response = await fetchImpl(new URL("index.json", base));
  if (!response.ok)
    throw new Error(`remote skill index failed: ${response.status}`);
  const index = await response.json();
  if (
    !index ||
    typeof index !== "object" ||
    !Array.isArray((index as { skills?: unknown }).skills)
  )
    throw new Error("remote skill index must contain a skills array");
  const sourceRoot = join(resolve(input.cacheRoot), cacheKey(base.href));
  const roots: string[] = [];
  for (const entry of (index as { skills: unknown[] }).skills) {
    if (!entry || typeof entry !== "object") continue;
    const skill = entry as {
      name?: unknown;
      version?: unknown;
      files?: unknown;
    };
    if (
      typeof skill.name !== "string" ||
      !safeSegment(skill.name) ||
      !Array.isArray(skill.files)
    )
      continue;
    // The index's file entries: bare strings (the legacy shape) or objects
    // carrying an optional sha256 declaration. A declaration is verified
    // against the downloaded bytes before the staging swap (cua's
    // client-verifies-before-use); an undeclared file is accepted — the
    // index chose not to pin it, which is the index's call, not ours.
    const files = skill.files
      .map((file) => {
        if (typeof file === "string")
          return safeRelativePath(file) ? ({ path: file } as const) : undefined;
        if (!file || typeof file !== "object") return undefined;
        const record = file as { path?: unknown; sha256?: unknown };
        if (typeof record.path !== "string" || !safeRelativePath(record.path))
          return undefined;
        return {
          path: record.path,
          ...(typeof record.sha256 === "string" && record.sha256
            ? { sha256: record.sha256 }
            : {}),
        } as { path: string; sha256?: string };
      })
      .filter(
        (file): file is { path: string; sha256?: string } => file !== undefined,
      );
    if (!files.some((file) => file.path === "SKILL.md")) continue;
    const root = join(sourceRoot, skill.name);
    const versionPath = join(root, ".natalia-version");
    const version =
      typeof skill.version === "string" ? skill.version : undefined;
    const current = await readOptional(versionPath);
    if (
      (await Bun.file(join(root, "SKILL.md")).exists()) &&
      (!version || current === version)
    ) {
      roots.push(root);
      continue;
    }
    const staging = `${root}.tmp-${crypto.randomUUID()}`;
    const backup = `${root}.old-${crypto.randomUUID()}`;
    let movedAside = false;
    try {
      for (const file of files) {
        const resource = new URL(
          file.path,
          new URL(`${encodeURIComponent(skill.name)}/`, base),
        );
        if (resource.origin !== base.origin)
          throw new Error("remote skill resource crosses origin");
        const downloaded = await fetchImpl(resource);
        if (!downloaded.ok)
          throw new Error(`remote skill file failed: ${downloaded.status}`);
        const bytes = new Uint8Array(await downloaded.arrayBuffer());
        // The declared digest is checked BEFORE the staging swap: the
        // catch below restores the previous skill, so a tampered or
        // truncated download never replaces a good one.
        if (file.sha256 && skillDigest(bytes) !== file.sha256)
          throw new RemoteSkillIntegrityError(
            `remote skill file digest mismatch: ${skill.name}/${file.path}`,
          );
        const destination = join(staging, file.path);
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        await writeFile(destination, bytes, { mode: 0o600 });
      }
      if (version)
        await writeFile(join(staging, ".natalia-version"), version, {
          mode: 0o600,
        });
      const exists = await Bun.file(join(root, "SKILL.md")).exists();
      if (exists) {
        await rename(root, backup);
        movedAside = true;
      }
      await rename(staging, root);
      movedAside = false;
      if (exists) await rm(backup, { recursive: true, force: true });
      roots.push(root);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      // Integrity failures propagate even when a cached skill survives: the
      // operator must be able to tell "network hiccup" from "the index
      // lied" — the second one is never silent.
      if (error instanceof RemoteSkillIntegrityError) throw error;
      // The previous skill was moved aside but the swap did not complete.
      // Without restoring it the skill is lost and the backup is orphaned.
      // Directory renames fail far more readily on Windows (an open handle,
      // a cwd inside the tree, or a directory watch is enough), but a POSIX
      // cross-device or out-of-space rename reaches the same state.
      if (movedAside) await rename(backup, root).catch(() => undefined);
      if (await Bun.file(join(root, "SKILL.md")).exists()) roots.push(root);
      else throw error;
    }
  }
  return roots;
}

export async function installSkill(input: {
  source: string;
  targetRoot: string;
  fetch?: typeof fetch;
}): Promise<{ installed: number; names: string[] }> {
  const targetRoot = input.targetRoot;
  await mkdir(targetRoot, { recursive: true, mode: 0o700 });
  const installed: string[] = [];

  if (/^https?:\/\//u.test(input.source)) {
    const cacheRoot = join(targetRoot, ".cache");
    const roots = await pullRemoteSkills({
      url: input.source,
      cacheRoot,
      fetch: input.fetch,
    });
    for (const root of roots) {
      const name = basename(root);
      await cp(root, join(targetRoot, name), {
        recursive: true,
        force: false,
      });
      installed.push(name);
    }
  } else {
    const source = resolve(input.source);
    const name = basename(source).replace(/\.skillo$/u, "");
    await cp(source, join(targetRoot, name), {
      recursive: true,
      force: false,
    });
    installed.push(name);
  }

  return { installed: installed.length, names: installed };
}

function cacheKey(url: string) {
  return createHash("sha256").update(url).digest("hex").slice(0, 24);
}

function safeSegment(value: string) {
  return (
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !/[\\/\0]/u.test(value)
  );
}

function safeRelativePath(value: string) {
  if (
    !value ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.includes("?") ||
    value.includes("#") ||
    isAbsolute(value)
  )
    return false;
  return value.split("/").every((segment) => safeSegment(segment));
}

async function readOptional(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readSkillDirectories(root: string) {
  try {
    return await readdir(root, { withFileTypes: true, encoding: "utf8" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function parseFrontmatter(input: string) {
  const result: Record<string, string> = {};
  for (const line of input.split(/\r?\n/u)) {
    const match = line.match(/^([\w-]+):\s*(.*)$/u);
    if (match)
      result[match[1]!] = match[2]!.trim().replace(/^['"]|['"]$/gu, "");
  }
  return result;
}

function recordValue(value: string | undefined) {
  const result: Record<string, string> = {};
  if (!value) return result;
  for (const item of value.replace(/^\{|\}$/gu, "").split(",")) {
    const separator = item.indexOf(":");
    if (separator < 0) continue;
    const key = item.slice(0, separator).trim();
    const command = item.slice(separator + 1).trim();
    if (key && command) result[key] = command;
  }
  return result;
}

function safeSkillEnv(env: NodeJS.ProcessEnv) {
  return Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM"]
      .map((key) => [key, env[key]] as const)
      .filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
  );
}

function required(value: string | undefined, name: string) {
  if (!value) throw new Error(`SKILL.md ${name} is required`);
  return value;
}

function listValue(value: string | undefined) {
  return value
    ? value
        .replace(/^\[|\]$/gu, "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function boolValue(value: string | undefined) {
  return value === "true";
}

function validateName(value: string) {
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(value))
    throw new Error("invalid skill name");
}
