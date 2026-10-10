import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  ExecutionTarget,
  RuntimeEvent,
  SandboxDiffKind,
  SandboxStatus,
} from "@anthelia/contracts";
import type { ConfinementMode } from "@anthelia/confinement";
import { wrapConfinedCommand } from "@anthelia/confinement";
import {
  forceRemove,
  shellQuote,
  startDetachedProcess,
} from "@anthelia/platform";
import { selectExecutor, type ShellSandboxInfo } from "@anthelia/shell";

// The shell that owns both spellings this file needs: the profile-reading argv
// for a foreground execute, and the detached POSIX launcher for a background
// one. One per module; it is stateless.
const shell = selectExecutor();

/**
 * The executor's confinement floor.
 *
 * The candidate's commands used to run as a plain local bash with a different
 * cwd: at the OS level a hostile `rm -rf /` inside a candidate escaped the
 * workspace as freely as the user's own shell. The floor is the shared
 * confinement seam the rest of the command surface already uses — one
 * policy, one classification, one fail-closed rule ("a missing or unusable
 * backend never degrades into running unconstrained").
 *
 * `danger-full-access` is the deliberate default for a directly constructed
 * manager: it is the seam's own "no confinement requested" spelling and
 * preserves the behaviour every existing caller has. The production path
 * (the sandbox controller) always passes the mode the runtime resolved.
 */
export type SandboxExecutorOptions = {
  confinementMode?: ConfinementMode;
  /** Host directories linked into each candidate (the dependency supply). */
  dependencyRoots?: readonly string[];
  /**
   * The confinement backend binary, overriding discovery. A valve for tests:
   * a path that does not exist exercises the fail-closed branch without
   * unsetting anything on the machine the test runs on.
   */
  confinementBinaryPath?: string;
};

/**
 * The timeout one sandboxed command gets, in milliseconds.
 *
 * The seam always applies a timeout, so routing the executor through it
 * introduces one where there was none: a stuck command used to hold the
 * turn open forever. The value is the seam's own maximum — a validation
 * command is a real build (`tsc -b --force` over this repository's sixty
 * packages is ~25s warm and minutes cold on a slow runner), and capping it
 * tighter would fail legitimate promotions.
 */
const SANDBOX_COMMAND_TIMEOUT_MS = 600_000;

export type IsolationLevel = "workspace" | "container" | "vm";

export type SandboxManifest = {
  id: string;
  root: string;
  isolationLevel: IsolationLevel;
  changedFiles: SandboxChange[];
  runningResources: string[];
  envAllowlist: string[];
  /** When the sandbox was created (ISO). */
  createdAt: string;
  /** When anything last happened to it (ISO): the TTL reads this. */
  updatedAt: string;
};

export type SandboxResourceInfo = {
  id: string;
  sandboxID: string;
  command: string;
  pid: number;
  status: "running" | "exited" | "failed" | "stopped";
  outputPath: string;
  startedAt: string;
  endedAt?: string;
};

export type SandboxChange = {
  kind: SandboxDiffKind;
  path: string;
  oldPath?: string;
  mode?: string;
  content?: string;
  patch?: string;
  before?: string;
  after?: string;
  additions?: number;
  deletions?: number;
  /**
   * The change exists but a promotion will not carry it: the workspace's
   * ignore rules (.nataliaignore) exclude the path. It is still REPORTED —
   * the 2026-10-07 smoke run wrote `.natalia/tool-smoke/...` inside a
   * sandbox, saw no diff, and then watched sandbox_delete list the same file
   * as a discardable change. Three surfaces must answer the same way about
   * one write: visible as a pending, ignored change, mergeable never.
   */
  ignored?: boolean;
  /** Why the change is ignored, when it is. */
  ignoreReason?: string;
};

export type SandboxManager = {
  create(id: string): Promise<SandboxManifest>;
  delete(
    id: string,
  ): Promise<{ pendingChanges: SandboxChange[]; runningResources: string[] }>;
  previewMerge(id: string): Promise<SandboxChange[]>;
  merge(
    id: string,
    hostRoot: string,
    authorize?: (paths: string[]) => Promise<void>,
  ): Promise<SandboxChange[]>;
  close(): Promise<void>;
};

export type SandboxExecutor = {
  target(id: string): ExecutionTarget;
  environment(
    allowlist: string[],
    source?: NodeJS.ProcessEnv,
  ): Record<string, string>;
  execute(
    id: string,
    command: string,
    options?: { signal?: AbortSignal; env?: NodeJS.ProcessEnv },
  ): Promise<{
    exitCode: number;
    output: string;
    target: ExecutionTarget;
    /**
     * What the sandbox actually did, when the run was confined: the mode
     * requested and whether the runner declined before the command could
     * run. Reported independently of the exit code, so a caller never has
     * to tell "the command failed" from "the policy refused" from "the
     * sandbox could not run at all" by guessing.
     */
    sandbox?: ShellSandboxInfo;
  }>;
};

export class WorkspaceSandboxManager
  implements SandboxManager, SandboxExecutor
{
  private sandboxes = new Map<string, SandboxManifest>();
  private resources = new Map<string, SandboxResourceInfo>();
  private initialized?: Promise<void>;
  /** The confinement mode every candidate command runs under. */
  private readonly confinementMode: ConfinementMode;
  /** The confinement backend override, when one was named. */
  private readonly confinementBinaryPath: string | undefined;

  constructor(
    private readonly baseRoot: string,
    options?: SandboxExecutorOptions,
  ) {
    this.confinementMode = options?.confinementMode ?? "danger-full-access";
    this.confinementBinaryPath = options?.confinementBinaryPath;
  }

  async initialize() {
    if (!this.initialized) this.initialized = this.load();
    await this.initialized;
  }

  async create(id: string) {
    await this.initialize();
    const root = resolve(this.baseRoot, id);
    await mkdir(root, { recursive: true });
    const now = new Date().toISOString();
    const manifest: SandboxManifest = {
      id,
      root,
      isolationLevel: "workspace",
      changedFiles: [],
      runningResources: [],
      envAllowlist: ["PATH", "HOME", "LANG", "TERM"],
      createdAt: now,
      updatedAt: now,
    };
    this.sandboxes.set(id, manifest);
    await this.persist(manifest);
    return manifest;
  }

  async list() {
    await this.initialize();
    return [...this.sandboxes.values()].map((manifest) => ({
      ...manifest,
      changedFiles: manifest.changedFiles.map((change) => ({ ...change })),
      runningResources: [...manifest.runningResources],
      envAllowlist: [...manifest.envAllowlist],
    }));
  }

  target(id: string): ExecutionTarget {
    const manifest = this.mustGet(id);
    return {
      kind: "sandbox",
      sandboxID: id,
      root: manifest.root,
      isolationLevel: manifest.isolationLevel,
    };
  }

  environment(allowlist: string[], source: NodeJS.ProcessEnv = process.env) {
    const env: Record<string, string> = {};
    for (const key of allowlist) {
      const value = source[key];
      if (value !== undefined && !isSecretEnvKey(key)) env[key] = value;
    }
    return env;
  }

  /**
   * Wraps a detached launcher script in the confinement binary.
   *
   * The script is a shell LINE (`bash -c '<command>' > log 2>&1 & echo $!`),
   * so the wrap runs it under `bash -c` inside the wrapper: the redirection
   * and the pid handshake stay exactly where the launcher expects them, and
   * the resource's own command lands under the write floor. Without this, a
   * resource — the one long-running surface — would be the hole the floor
   * claims to close.
   *
   * Fail-closed like every other command surface: with no usable backend
   * this REFUSES rather than starting the resource unconfined, because a
   * silent unconfined passthrough is the one thing the floor must never do.
   */
  private confinedScript(script: string, workspaceRoot: string): string {
    if (this.confinementMode === "danger-full-access") return script;
    const wrapped = wrapConfinedCommand({
      mode: this.confinementMode,
      workspaceRoot,
      command: "bash",
      args: ["-c", script],
      ...(this.confinementBinaryPath
        ? { binaryPath: this.confinementBinaryPath }
        : {}),
    });
    if (!wrapped)
      throw new Error(
        `the ${this.confinementMode} sandbox could not start this resource: no ` +
          `usable confinement-exec backend was found on this host, and the ` +
          `sandbox refuses to run a command unconfined. Build the backend ` +
          `(bun run native:confinement) or run this call under ` +
          `sandbox_permissions=danger-full-access.`,
      );
    return [wrapped.command, ...wrapped.args.map(shellQuote)].join(" ");
  }

  /**
   * Runs one command inside the candidate.
   *
   * Through the shared shell seam rather than a raw spawn, which is what puts
   * the confinement floor under it: the candidate root is the writable root,
   * so a command inside the candidate reads the host's linked dependencies
   * and cannot write outside its own worktree. A missing backend fails
   * CLOSED — the run refuses with the wrapper's own sentence instead of
   * silently degrading to an unconstrained spawn — and the returned `sandbox`
   * fact says what the sandbox actually did (the mode requested, and whether
   * the runner declined before the command could run), so a caller never has
   * to infer either from an exit code.
   */
  async execute(
    id: string,
    command: string,
    options: { signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {},
  ) {
    const manifest = this.mustGet(id);
    // The profile-reading invocation, which is what this call site has always
    // used: a sandboxed workspace executes with the user's shell profile.
    const spec = shell.resolve({
      command,
      workdir: manifest.root,
      loginShell: true,
      timeoutMs: SANDBOX_COMMAND_TIMEOUT_MS,
      confinement: this.confinementMode,
      workspaceRoot: manifest.root,
      signal: options.signal,
      env: this.environment(manifest.envAllowlist, options.env),
      ...(this.confinementBinaryPath
        ? { confinementBinaryPath: this.confinementBinaryPath }
        : {}),
    });
    const run = await shell.run(spec, {
      command,
      confinement: this.confinementMode,
      workspaceRoot: manifest.root,
      signal: options.signal,
      ...(this.confinementBinaryPath
        ? { confinementBinaryPath: this.confinementBinaryPath }
        : {}),
    });
    // "Could not run" is not "ran and failed": the confinement refusal (no
    // usable backend) and a runner decline both arrive here, and both must
    // read as the sandbox refusing rather than as the command's exit.
    if (run.outcome === "spawn-failed")
      throw new Error(
        run.confinementRefusal ?? "the command could not be started",
      );
    if (run.outcome === "aborted")
      throw options.signal?.reason ?? new Error("command cancelled");
    if (run.outcome === "timeout")
      throw new Error(
        `sandbox command timed out after ${SANDBOX_COMMAND_TIMEOUT_MS / 1000}s`,
      );
    return {
      exitCode: run.exitCode ?? -1,
      output: `${run.stdout}${run.stderr}`,
      target: this.target(id),
      ...(run.sandbox ? { sandbox: run.sandbox } : {}),
    };
  }

  async startResource(id: string, command: string, resourceID?: string) {
    await this.initialize();
    const manifest = this.mustGet(id);
    const finalID =
      resourceID ?? `sbx_${id}_${manifest.runningResources.length + 1}`;
    if (this.resources.has(finalID))
      throw new Error(`sandbox resource already exists: ${finalID}`);
    const outputPath = resolve(
      manifest.root,
      ".natalia",
      "resources",
      `${finalID}.log`,
    );
    await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
    // The launcher script runs the resource's command; confining the SCRIPT
    // (rather than the command text) keeps the redirection and the `$!`
    // handshake intact while the command itself lands under the same floor
    // as every other candidate command. Without this, a resource — the one
    // long-running surface — would be the hole the floor claims to close.
    const script = shell.detachedPosixScript({ command, outputPath });
    const posixScript = this.confinedScript(script, manifest.root);
    const { pid } = await startDetachedProcess({
      command,
      posixScript,
      cwd: manifest.root,
      outputPath,
      env: this.environment(manifest.envAllowlist),
    });
    const resource: SandboxResourceInfo = {
      id: finalID,
      sandboxID: id,
      command,
      pid,
      status: "running",
      outputPath,
      startedAt: new Date().toISOString(),
    };
    this.resources.set(finalID, resource);
    manifest.runningResources.push(finalID);
    await this.persist(manifest);
    return { ...resource };
  }

  resourcesFor(id: string) {
    const manifest = this.mustGet(id);
    return manifest.runningResources
      .map((resourceID) => this.refreshResource(this.resources.get(resourceID)))
      .filter(
        (resource): resource is SandboxResourceInfo => resource !== undefined,
      );
  }

  runningResourceCount(): number {
    return [...this.resources.values()].filter(
      (resource) => this.refreshResource(resource)?.status === "running",
    ).length;
  }

  async close() {
    if (!this.initialized) return;
    await this.initialized;
    const errors: unknown[] = [];
    for (const manifest of this.sandboxes.values())
      for (const resourceID of [...manifest.runningResources])
        try {
          await this.stopResource(manifest.id, resourceID);
        } catch (error) {
          errors.push(error);
        }
    if (errors.length)
      throw new AggregateError(errors, "sandbox resource cleanup failed");
  }

  async resourceOutput(id: string, resourceID: string, maxBytes = 20000) {
    this.mustGet(id);
    const resource = this.mustResource(resourceID);
    try {
      return (await readFile(resource.outputPath, "utf8")).slice(-maxBytes);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    }
  }

  async stopResource(id: string, resourceID: string) {
    await this.initialize();
    const manifest = this.mustGet(id);
    const resource = this.mustResource(resourceID);
    if (resource.status === "running") process.kill(resource.pid, "SIGTERM");
    resource.status = "stopped";
    resource.endedAt = new Date().toISOString();
    manifest.runningResources = manifest.runningResources.filter(
      (item) => item !== resourceID,
    );
    await this.persist(manifest);
    return { ...resource };
  }

  async write(id: string, path: string, content: string, mode?: string) {
    await this.initialize();
    const manifest = this.mustGet(id);
    const full = await containPath(manifest.root, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
    this.record(id, { kind: "modify", path, mode, content });
    await this.persist(manifest);
  }

  async deletePath(id: string, path: string) {
    await this.initialize();
    const manifest = this.mustGet(id);
    const full = await containPath(manifest.root, path);
    await rm(full, { recursive: true, force: true });
    this.record(id, { kind: "delete", path });
    await this.persist(manifest);
  }

  async renamePath(id: string, oldPath: string, path: string) {
    await this.initialize();
    const manifest = this.mustGet(id);
    const oldFull = await containPath(manifest.root, oldPath);
    const newFull = await containPath(manifest.root, path);
    await mkdir(dirname(newFull), { recursive: true });
    await rename(oldFull, newFull);
    this.record(id, { kind: "rename", oldPath, path });
    await this.persist(manifest);
  }

  async modePath(id: string, path: string, mode: string) {
    await this.initialize();
    await containPath(this.mustGet(id).root, path);
    this.record(id, { kind: "mode", path, mode });
    await this.persist(this.mustGet(id));
  }

  /**
   * Validates the candidate, then promotes it. Empty commands are refused so a
   * missing check cannot be mistaken for a green promote.
   *
   * The validation's own result rides back on the return value: the caller
   * used to run the SAME command once more before calling this, which (a)
   * paid for the gate twice and (b) left the first run's build output in the
   * candidate, where the artifact cleanup below — keyed on what appeared
   * after ITS OWN before-capture — could no longer see it, so a promotion
   * merged artifacts the gate itself produced. One run, reported once.
   */
  async promoteWithValidation(
    id: string,
    input: {
      command: string;
      authorize?: (paths: string[]) => Promise<void>;
      hostRoot?: string;
    },
  ): Promise<{
    sandboxID: string;
    changedFiles: SandboxChange[];
    lastKnownGood?: string;
    validation: { ok: boolean; exitCode: number; output: string };
  }> {
    const command = input.command.trim();
    if (!command) throw new Error("sandbox promote command must not be empty");
    const hostRoot = input.hostRoot;
    if (!hostRoot) throw new Error("sandbox promote requires hostRoot");
    // F1 (2026-10-10 sweep): the validation runs INSIDE the candidate, so
    // whatever it builds lands in the candidate — and the merge then diffs
    // the candidate and promotes the validation's own artifacts into the
    // host. The audit measured `.cmake-verify/` (libneon.a, Makefile, a
    // CMakeCache.txt with the sandbox's absolute path) merged into the real
    // workspace: validation passing is what polluted the host.
    //
    // The candidate's index is captured BEFORE validation; afterwards the
    // delta is exactly the validation's own output, which is deleted from the
    // candidate and the index restored. The gate keeps testing the change;
    // the change stays what the model made.
    const beforeValidation = await this.captureForValidation(id);
    const evidence = await this.validate(id, command);
    const artifacts = await this.validationArtifacts(id, beforeValidation);
    const sandboxRoot = this.mustGet(id).root;
    for (const path of artifacts)
      await rm(await containPath(sandboxRoot, path), {
        recursive: true,
        force: true,
      });
    await this.restoreCandidateIndex(id, beforeValidation);
    if (!evidence.ok)
      throw new Error(
        `candidate ${id} failed validation (exit ${evidence.exitCode}):\n${evidence.output.slice(0, 2000)}`,
      );
    const changedFiles = await this.merge(id, hostRoot, input.authorize);
    // Reported rather than assumed: the completion record states whether a
    // rollback point exists, and a constant would be a claim the backend never
    // checked.
    const rollbackPoint = await this.rollbackPoint(id);
    return {
      sandboxID: id,
      changedFiles,
      ...(rollbackPoint ? { lastKnownGood: rollbackPoint } : {}),
      validation: evidence,
    };
  }

  /**
   * Undoes one sandbox's promotion, restoring the host to what it was before.
   *
   * Takes the sandbox id because that is what the caller has: an entry point
   * that reaches a rollback by sandbox id is the only shape that can be exposed
   * as a tool. `restored: false` means there was nothing to undo.
   */
  async rollback(_id: string): Promise<{ restored: boolean; reason?: string }> {
    return {
      restored: false,
      reason: "this backend keeps no rollback point for a promotion",
    };
  }

  /**
   * A marker for the rollback point a promotion left, or undefined when it left
   * none. Backends name it differently — a commit, a backup directory — so the
   * marker is opaque and only its presence is meaningful.
   */
  protected async rollbackPoint(_id: string): Promise<string | undefined> {
    return undefined;
  }

  /**
   * The candidate's index before validation runs, so the validation's own
   * output can be told apart from the model's change (F1). The snapshot
   * backend captures it; a backend that cannot leaves the merge as it was.
   */
  protected async captureForValidation(_id: string): Promise<unknown> {
    return undefined;
  }

  /** The paths validation created inside the candidate (F1). */
  protected async validationArtifacts(
    _id: string,
    _before: unknown,
  ): Promise<string[]> {
    return [];
  }

  /** Put the candidate's index back to its pre-validation state (F1). */
  protected async restoreCandidateIndex(
    _id: string,
    _before: unknown,
  ): Promise<void> {}

  /**
   * The promotion gate's command, run INSIDE the candidate (T2-2: the gate's
   * meaning is to validate the model's change, and the candidate is where
   * that change lives). Through the same confined seam as {@link execute}, so
   * a validation command reads the candidate's linked dependencies and writes
   * nowhere else.
   */
  async validate(
    id: string,
    command: string,
  ): Promise<{ ok: boolean; exitCode: number; output: string }> {
    const manifest = this.mustGet(id);
    const spec = shell.resolve({
      command,
      workdir: manifest.root,
      loginShell: true,
      timeoutMs: SANDBOX_COMMAND_TIMEOUT_MS,
      confinement: this.confinementMode,
      workspaceRoot: manifest.root,
      ...(this.confinementBinaryPath
        ? { confinementBinaryPath: this.confinementBinaryPath }
        : {}),
    });
    const run = await shell.run(spec, {
      command,
      confinement: this.confinementMode,
      workspaceRoot: manifest.root,
      ...(this.confinementBinaryPath
        ? { confinementBinaryPath: this.confinementBinaryPath }
        : {}),
    });
    if (run.outcome === "spawn-failed")
      throw new Error(
        run.confinementRefusal ?? "the command could not be started",
      );
    if (run.outcome === "aborted") throw new Error("command cancelled");
    if (run.outcome === "timeout")
      throw new Error(
        `sandbox validation timed out after ${SANDBOX_COMMAND_TIMEOUT_MS / 1000}s`,
      );
    return {
      ok: run.exitCode === 0,
      exitCode: run.exitCode ?? -1,
      output: `${run.stdout}${run.stderr}`,
    };
  }

  async previewMerge(id: string) {
    const manifest = this.mustGet(id);
    manifest.changedFiles = classifyRenames(manifest.changedFiles);
    return manifest.changedFiles.map((change) => ({ ...change }));
  }

  async merge(
    id: string,
    hostRoot: string,
    authorize?: (paths: string[]) => Promise<void>,
  ) {
    await this.initialize();
    const manifest = this.mustGet(id);
    const changes = await this.previewMerge(id);
    const previewRevision = JSON.stringify(changes);
    await authorize?.(mergeMutationPaths(changes));
    if (JSON.stringify(manifest.changedFiles) !== previewRevision)
      throw new Error("sandbox manifest changed during merge authorization");
    const backups: Array<{ path: string; content?: Buffer; existed: boolean }> =
      [];
    try {
      for (const change of changes) {
        const target = await containPath(hostRoot, change.path);
        const oldTarget = change.oldPath
          ? await containPath(hostRoot, change.oldPath)
          : undefined;
        const existing = await readOptional(target);
        backups.push({
          path: target,
          content: existing,
          existed: existing !== undefined,
        });
        if (oldTarget) {
          const old = await readOptional(oldTarget);
          backups.push({
            path: oldTarget,
            content: old,
            existed: old !== undefined,
          });
        }
        if (change.kind === "delete") {
          await forceRemove(target, { recursive: true });
        } else if (change.kind === "mode") {
          if (!change.mode)
            throw new Error("sandbox mode change is missing mode");
          await chmod(target, Number.parseInt(change.mode, 8));
        } else {
          await mkdir(dirname(target), { recursive: true });
          const source = await containPath(manifest.root, change.path);
          await writeFile(target, await readFile(source));
          if (change.mode) await chmod(target, Number.parseInt(change.mode, 8));
          if (oldTarget) await forceRemove(oldTarget, { recursive: true });
        }
      }
      manifest.changedFiles = [];
      await this.persist(manifest);
      return changes;
    } catch (error) {
      for (const backup of backups.reverse()) {
        // A merged `mode` change may have made this path read-only, which
        // blocks a plain force remove on Windows and would strand the rollback.
        if (!backup.existed) await forceRemove(backup.path);
        else if (backup.content) await writeFile(backup.path, backup.content);
      }
      throw error;
    }
  }

  /**
   * Collect the sandboxes the TTL and the cap name (P2-18).
   *
   * A sandbox with UNMERGED changes is never collected — that is a reader's
   * unfinished work, not garbage — and neither is one with running
   * resources. Returns the ids it deleted, so a caller can say what happened.
   */
  async collectIdle(input: {
    maxIdleHours: number;
    maxSandboxes?: number;
  }): Promise<string[]> {
    await this.initialize();
    const now = Date.now();
    const idleBefore =
      input.maxIdleHours > 0 ? now - input.maxIdleHours * 3_600_000 : undefined;
    const candidates = [...this.sandboxes.values()]
      .filter((manifest) => manifest.changedFiles.length === 0)
      .filter((manifest) => manifest.runningResources.length === 0)
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
    const collected: string[] = [];
    const cap = input.maxSandboxes ?? 0;
    for (const manifest of candidates) {
      const idle =
        idleBefore !== undefined && Date.parse(manifest.updatedAt) < idleBefore;
      // The cap counts EVERY sandbox, so the clean ones go first until the
      // workspace is back under it — a dirty one is simply not a candidate,
      // it is never collected.
      const overCap = cap > 0 && this.sandboxes.size - collected.length > cap;
      if (!idle && !overCap) continue;
      collected.push(manifest.id);
    }
    for (const id of collected) await this.delete(id);
    return collected;
  }

  async delete(id: string) {
    await this.initialize();
    const manifest = this.mustGet(id);
    const pendingChanges = manifest.changedFiles.map((change) => ({
      ...change,
    }));
    // The discard is the fact the caller approves: deleting a sandbox with
    // pending changes destroys that work, and a result of bare arrays left
    // the caller to infer it (T-10).
    // P1-14: the paths are DEDUPED, and the count is the deduped count. A
    // rename (or a change set that touches one path twice) used to list the
    // same path repeatedly with `discardedChanges` inflated to match — the
    // 2026-10-08 audit measured `package.json` twice and
    // `discardedChanges: 3` for two real paths. The caller approves the
    // destruction of N paths, so N must be the number of paths.
    const discardedPaths = [
      ...new Set(pendingChanges.map((change) => change.path)),
    ];
    const result = {
      deleted: true,
      discardedChanges: discardedPaths.length,
      discardedPaths,
      pendingChanges,
      runningResources: [...manifest.runningResources],
    };
    for (const resourceID of manifest.runningResources)
      await this.stopResource(id, resourceID).catch(() => undefined);
    this.sandboxes.delete(id);
    await forceRemove(manifest.root, { recursive: true });
    return result;
  }

  /**
   * The sandbox's status event.
   *
   * The manifest can only describe two states — has changes, has none — so a
   * caller naming a transition the manifest cannot see (a merge that was
   * previewed, landed, or conflicted) passes it explicitly. Left to the default
   * those transitions were unreportable, and `merge_previewed`/`merged`/
   * `conflicted` were vocabulary nothing could emit.
   */
  updateEvent(id: string, status?: SandboxStatus): RuntimeEvent {
    const manifest = this.mustGet(id);
    return {
      type: "sandbox.update",
      id,
      status: status ?? (manifest.changedFiles.length ? "changed" : "created"),
      root: manifest.root,
      isolationLevel: manifest.isolationLevel,
      changedFiles: manifest.changedFiles.length,
      runningResources: manifest.runningResources.length,
      target: this.target(id),
      resourcePolicy:
        "workspace isolation only; no namespace/container/VM limits",
    };
  }

  diffEvent(id: string): RuntimeEvent {
    return { type: "sandbox.diff", id, changes: this.mustGet(id).changedFiles };
  }

  auditEvent(
    id: string,
    action: string,
    approvalRequired = true,
  ): RuntimeEvent {
    return {
      type: "sandbox.audit",
      id,
      action,
      target: this.target(id),
      approvalRequired,
      checkpointPolicy: "sandbox_manifest",
      message: "Sandbox is workspace isolation, not container or VM security.",
    };
  }

  private record(id: string, change: SandboxChange) {
    const manifest = this.mustGet(id);
    manifest.changedFiles.push(change);
  }

  private async load() {
    const entries = await readdir(this.baseRoot, { withFileTypes: true }).catch(
      () => [],
    );
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const state = JSON.parse(
          await readFile(
            join(this.baseRoot, entry.name, ".natalia-manifest.json"),
            "utf8",
          ),
        ) as { manifest?: SandboxManifest; resources?: SandboxResourceInfo[] };
        if (!state.manifest || state.manifest.id !== entry.name) continue;
        const manifest = {
          ...state.manifest,
          root: resolve(this.baseRoot, entry.name),
        };
        manifest.runningResources = [];
        this.sandboxes.set(manifest.id, manifest);
        for (const resource of state.resources ?? [])
          this.resources.set(resource.id, {
            ...resource,
            sandboxID: resource.sandboxID ?? manifest.id,
            status: resource.status === "running" ? "stopped" : resource.status,
            endedAt:
              resource.status === "running"
                ? new Date().toISOString()
                : resource.endedAt,
          });
        await this.persist(manifest);
      } catch {
        // An invalid sandbox manifest is ignored rather than granting access.
      }
    }
  }

  private async persist(manifest: SandboxManifest) {
    // Every write to a manifest is activity: the TTL reads this, so a
    // sandbox someone is working in is never collected as idle.
    manifest.updatedAt = new Date().toISOString();
    await mkdir(manifest.root, { recursive: true, mode: 0o700 });
    await writeFile(
      join(manifest.root, ".natalia-manifest.json"),
      `${JSON.stringify(
        {
          manifest,
          resources: [...this.resources.values()].filter(
            (resource) => resource.sandboxID === manifest.id,
          ),
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
  }

  /**
   * The manifest for a sandbox, or a refusal. `protected` because the
   * worktree backend extends this manager and its git operations need the
   * same "does this sandbox exist" answer the base surface gives.
   */
  protected mustGet(id: string) {
    const manifest = this.sandboxes.get(id);
    if (!manifest) throw new Error(`unknown sandbox: ${id}`);
    return manifest;
  }

  private mustResource(id: string) {
    const resource = this.refreshResource(this.resources.get(id));
    if (!resource) throw new Error(`unknown sandbox resource: ${id}`);
    return resource;
  }

  private refreshResource(resource: SandboxResourceInfo | undefined) {
    if (!resource || resource.status !== "running") return resource;
    try {
      process.kill(resource.pid, 0);
    } catch {
      resource.status = "exited";
      resource.endedAt = new Date().toISOString();
    }
    return resource;
  }
}

export async function containPath(root: string, requested: string) {
  if (isAbsolute(requested))
    throw new Error("absolute sandbox paths are not allowed");
  const resolvedRoot = resolve(root);
  const target = resolve(resolvedRoot, requested);
  const rel = relative(resolvedRoot, target);
  if (rel.startsWith("..") || isAbsolute(rel))
    throw new Error("sandbox path escape blocked");
  await rejectSymlinkEscape(resolvedRoot, target);
  return target;
}

export function isSecretEnvKey(key: string) {
  return /(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY|AUTHORIZATION)/iu.test(key);
}

function classifyRenames(changes: SandboxChange[]) {
  const normalized: SandboxChange[] = [];
  for (const change of changes) {
    if (change.kind === "rename" && change.oldPath)
      removeChangesForPath(normalized, change.oldPath);
    if (change.kind === "delete") removeChangesForPath(normalized, change.path);
    normalized.push({ ...change });
  }
  return normalized;
}

function mergeMutationPaths(changes: SandboxChange[]) {
  return [
    ...new Set(
      changes.flatMap((change) =>
        change.oldPath ? [change.path, change.oldPath] : [change.path],
      ),
    ),
  ].sort();
}

function removeChangesForPath(changes: SandboxChange[], path: string) {
  for (let index = changes.length - 1; index >= 0; index--) {
    const change = changes[index]!;
    if (change.path === path) changes.splice(index, 1);
  }
}

async function rejectSymlinkEscape(root: string, target: string) {
  let cursor = dirname(target);
  while (cursor.startsWith(root)) {
    try {
      const stats = await lstat(cursor);
      if (stats.isSymbolicLink()) {
        const real = await realpath(cursor);
        if (!real.startsWith(root))
          throw new Error("sandbox symlink escape blocked");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}

async function readOptional(path: string) {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
