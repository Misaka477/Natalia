/**
 * Tools that work inside a workspace sandbox.
 */
/**
 * Tools that work inside a workspace sandbox.
 *
 * A sandbox is a copy of the workspace the model may change freely; merging is the
 * only way changes reach the real tree, and it is the only action here that asks
 * for authorization on the paths involved. Every tool refuses to run without a
 * sandbox manager rather than silently falling back to the workspace, because
 * "isolation was unavailable" must never be indistinguishable from "isolation
 * happened".
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { optionalString, requireObject, requireString } from "@anthelia/tools";
import type {
  RuntimeTool,
  SandboxToolService,
  ToolCard,
  ToolExecutionContext,
  ToolFamily,
  ToolOutputDefinition,
} from "@anthelia/tools";
import type {
  RuntimeStructuredDiffHunk,
  SandboxDiffKind,
} from "@anthelia/contracts";

function requireSandboxes(context: ToolExecutionContext) {
  if (!context.sandboxes) throw new Error("sandbox runtime unavailable");
  return context.sandboxes;
}

/**
 * The project markers a promotion's validation command can be derived from,
 * with the check each one runs. Ordered: the first marker found wins, so a
 * workspace carrying several declares its primary build by which file sits at
 * its root.
 *
 * The command speaks the project's own vocabulary — `npm run typecheck` for a
 * package.json workspace, cmake's configure+build for a CMake one — because a
 * merge validated by the WRONG toolchain's command proves nothing about the
 * merged tree. The 2026-10-06 smoke run merged a CMake project and watched it
 * validated by `npm run typecheck` (T-09).
 */
/**
 * The merge answer's default bounds (F2, 2026-10-10 sweep).
 *
 * The audit measured one added file answering 117 pages / 5.87 MB, and a
 * sweep spilling ~11.9 MB into `.natalia/tool-output/`. A merge's answer is
 * WHICH files changed — the counts, not the patches.
 */
const MERGE_MAX_LINES = 60;
const MERGE_MAX_BYTES = 20_000;

/** A byte-capped text, with the original size for the note. */
function boundedText(
  text: string,
  maxBytes: number,
): { body: string; truncated: boolean; totalBytes: number } {
  const totalBytes = Buffer.byteLength(text, "utf8");
  if (totalBytes <= maxBytes)
    return { body: text, truncated: false, totalBytes };
  return { body: text.slice(0, maxBytes), truncated: true, totalBytes };
}

const PROMOTE_MARKERS: ReadonlyArray<{ file: string; command: string }> = [
  { file: "package.json", command: "npm run typecheck" },
  {
    file: "CMakeLists.txt",
    command: "cmake -S . -B build && cmake --build build",
  },
  { file: "Cargo.toml", command: "cargo check" },
  { file: "pyproject.toml", command: "python -m compileall ." },
];

/**
 * The validation command a workspace's own project markers imply, or
 * `undefined` when none is recognized. Pure over the filesystem: the caller
 * (sandbox_merge) treats `undefined` as "ask for an explicit command" rather
 * than guessing one.
 */
export function detectPromoteCommand(
  workspaceRoot: string,
): { command: string; marker: string } | undefined {
  for (const marker of PROMOTE_MARKERS)
    if (existsSync(join(workspaceRoot, marker.file)))
      return { command: marker.command, marker: marker.file };
  return undefined;
}

/**
 * The sandbox family's card (R5) — the family that had almost none.
 *
 * Before this, ten of the eleven tools declared no output definition at all,
 * so every sandbox row fell to the generic path and read as a raw sentence.
 * One factory now covers the family, the way the process and terminal
 * families do: ONE decode in `presentationMeta`, and the card composed from
 * those facts — a command's exit and output as the terminal card's structured
 * fields, a merge's real hunks as the diff card's, everything else as the
 * envelope facts a generic card reads.
 */
type SandboxFacts = {
  id?: string;
  backend?: string;
  status?: string;
  exitCode?: number;
  /** The command's own output text (an execute, a resource read). */
  text?: string;
  command?: string;
  resourceID?: string;
  pid?: number;
  path?: string;
  /** A change set's counts (diff, merge, delete) and a list's row count. */
  total?: number;
  /** How many rows of a list answer hold unmerged changes (sandbox_list). */
  unmerged?: number;
  additions?: number;
  deletions?: number;
  restored?: boolean;
  deleted?: boolean;
  discardedChanges?: number;
  reason?: string;
  /** A change set's real hunks, for the diff card. */
  hunks?: RuntimeStructuredDiffHunk[];
  paths?: string[];
};

function argsRecord(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {};
}

/** A change set's facts: the counts, the paths, and the REAL hunks. */
function changeSetFacts(changes: Array<Record<string, unknown>>): SandboxFacts {
  let additions = 0;
  let deletions = 0;
  const hunks: RuntimeStructuredDiffHunk[] = [];
  for (const change of changes) {
    if (typeof change.additions === "number") additions += change.additions;
    if (typeof change.deletions === "number") deletions += change.deletions;
    const structured = change.structured as
      | { hunks?: RuntimeStructuredDiffHunk[] }
      | undefined;
    if (Array.isArray(structured?.hunks)) hunks.push(...structured.hunks);
  }
  return {
    total: changes.length,
    additions,
    deletions,
    ...(hunks.length > 0 ? { hunks } : {}),
    paths: changes
      .map((change) => optionalString(change.path))
      .filter((path): path is string => path !== undefined),
  };
}

function sandboxFacts(value: string): SandboxFacts {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch {
    // An `exit=N\n<output>` or a prose answer: no envelope, no facts.
    return {};
  }
  if (Array.isArray(decoded)) {
    // A change set answers as a bare array (sandbox_diff, sandbox_merge):
    // the counts and the real hunks live on its items.
    return changeSetFacts(decoded as Array<Record<string, unknown>>);
  }
  if (!decoded || typeof decoded !== "object") return {};
  const record = decoded as Record<string, unknown>;
  const facts: SandboxFacts = {};
  const id = optionalString(record.id);
  if (id !== undefined) facts.id = id;
  const backend = optionalString(record.backend);
  if (backend !== undefined) facts.backend = backend;
  const status = optionalString(record.status);
  if (status !== undefined) facts.status = status;
  if (typeof record.exitCode === "number") facts.exitCode = record.exitCode;
  if (typeof record.pid === "number") facts.pid = record.pid;
  const resourceID = optionalString(record.resourceID);
  if (resourceID !== undefined) facts.resourceID = resourceID;
  const command = optionalString(record.command);
  if (command !== undefined) facts.command = command;
  const path = optionalString(record.path);
  if (path !== undefined) facts.path = path;
  if (typeof record.restored === "boolean") facts.restored = record.restored;
  if (typeof record.deleted === "boolean") facts.deleted = record.deleted;
  if (typeof record.discardedChanges === "number")
    facts.discardedChanges = record.discardedChanges;
  const reason = optionalString(record.reason);
  if (reason !== undefined) facts.reason = reason;
  // A change set nested in an envelope (a delete's discards).
  const changes = Array.isArray(record.changes)
    ? (record.changes as Array<Record<string, unknown>>)
    : undefined;
  if (changes) Object.assign(facts, changeSetFacts(changes));
  return facts;
}

function pill(label: string, value: string): [label: string, value: string] {
  return [label, value];
}

type SandboxCardInput = {
  /** The row's title: the sandbox id, the command, or the family. */
  title: "id" | "command" | "family";
  callSummary: string;
  resultSummary: (facts: SandboxFacts) => string;
  facets?: (facts: SandboxFacts) => Array<[label: string, value: string]>;
  /** The card kind: a command's own run is terminal; a change set is a diff. */
  kind?: "terminal" | "diff" | "generic";
  /** The command from the arguments, as the card's structured field. */
  command?: boolean;
  /** The run's own text (an output), as the terminal card's field. */
  text?: boolean;
  /** The exit code, parsed from the run's first line. */
  exit?: boolean;
  /** The change set's real hunks, as the diff card's field. */
  hunks?: boolean;
};

/** A text result IS the card's output, for a card that carries one. */
function withText(
  facts: SandboxFacts,
  input: SandboxCardInput,
  value: string,
): void {
  if (input.text === true && facts.text === undefined) facts.text = value;
}

function sandboxToolCard(input: SandboxCardInput): ToolOutputDefinition {
  const cardKind = input.kind ?? "generic";
  const callTitle = (args: unknown): string => {
    const parsed = argsRecord(args);
    if (input.title === "command")
      return optionalString(parsed.command) ?? "sandbox";
    if (input.title === "id") return optionalString(parsed.id) ?? "sandbox";
    return "sandbox";
  };
  return {
    schema: { type: "object", properties: {} },
    presentCall(args) {
      return {
        kind: cardKind,
        title: callTitle(args),
        summary: input.callSummary,
      };
    },
    presentationMeta(args, value) {
      // ONE decode (R5): the facts travel the event's meta slot and come
      // straight back to the presenter. An `exit=N` first line is a fact
      // too — the family's execute answers with it, not with an envelope.
      const facts = sandboxFacts(value);
      const record = argsRecord(args);
      if (input.command === true) {
        const command = optionalString(record.command);
        if (command !== undefined) facts.command = command;
      }
      if (input.exit === true && facts.exitCode === undefined) {
        const first = value.split("\n", 1)[0] ?? "";
        const exit = /^exit=(\d+)$/u.exec(first.trim())?.[1];
        if (exit !== undefined) {
          facts.exitCode = Number(exit);
          facts.text = value.slice(first.length).replace(/^\n/u, "");
        }
      }
      // A text result (a retained dump) IS the output: no envelope to
      // decode, and the card still carries the text as its field.
      withText(facts, input, value);
      return facts as Record<string, unknown>;
    },
    presentResult(args, value, meta) {
      const facts =
        meta === undefined ? sandboxFacts(value) : (meta as SandboxFacts);
      // The same text rule the facts reader applies, so a caller without
      // the meta slot (a direct two-argument call) reads the same card.
      withText(facts, input, value);
      const facets = input.facets?.(facts) ?? [];
      return {
        kind: cardKind,
        title: callTitle(args),
        summary: input.resultSummary(facts),
        ...(input.command === true && facts.command !== undefined
          ? { command: facts.command }
          : {}),
        ...(input.text === true && facts.text !== undefined
          ? { output: facts.text }
          : {}),
        ...(input.exit === true && facts.exitCode !== undefined
          ? { exitCode: facts.exitCode }
          : {}),
        ...(input.hunks === true && facts.hunks !== undefined
          ? { hunks: facts.hunks, path: facts.paths?.[0] }
          : {}),
        ...(facets.length > 0 ? { meta: facets } : {}),
        // A change set's own paths, when the card is a diff of several.
        ...(facts.paths && facts.paths.length > 1 && cardKind === "diff"
          ? { meta: [...facets, pill("files", String(facts.paths.length))] }
          : {}),
      } as ToolCard;
    },
  };
}

function sandboxCreateTool(): RuntimeTool {
  return {
    name: "sandbox_create",
    description: "Create a TS workspace-isolated sandbox.",
    requiresApproval: true,
    parameters: {
      type: "object",
      properties: { id: { type: "string" }, maxLines: { type: "number" } },
      required: ["id"],
      additionalProperties: false,
    },
    output: sandboxToolCard({
      title: "id",
      callSummary: "create",
      resultSummary: (facts) =>
        facts.backend ? `created · ${facts.backend} backend` : "created",
      facets: (facts) =>
        facts.backend ? [pill("backend", facts.backend)] : [],
    }),
    async execute(input, context) {
      const args = requireObject(input);
      const id = requireString(args.id, "id");
      const manager = requireSandboxes(context);
      // P2-18: the cap is enforced here, so a workspace cannot grow past it
      // without anyone noticing — the 2026-10-08 audit found 14 stale
      // sandboxes (56MB) precisely because nothing ever reclaimed one. A
      // sandbox with unmerged work is never collected (the manager's rule).
      const sandboxConfig = (
        context.runtimeConfig?.() as
          | { sandbox?: { maxIdleHours?: number; maxSandboxes?: number } }
          | undefined
      )?.sandbox;
      const maxIdleHours = sandboxConfig?.maxIdleHours ?? 168;
      const maxSandboxes = sandboxConfig?.maxSandboxes ?? 0;
      // `maxSandboxes - 1`: one is about to be created, and the cap is the
      // number that may EXIST afterwards.
      if (maxIdleHours > 0 || maxSandboxes > 0)
        await manager.collectIdle({
          maxIdleHours,
          ...(maxSandboxes > 0 ? { maxSandboxes: maxSandboxes - 1 } : {}),
        });
      const sandbox = await manager.create(id);
      context.onSandboxEvent?.(requireSandboxes(context).updateEvent(id));
      context.onSandboxEvent?.(
        requireSandboxes(context).auditEvent(id, "create"),
      );
      // The resolved config by name (the D2 runtime.config service): the tool
      // says which backend actually created the sandbox.
      const backend =
        (
          context.runtimeConfig?.() as
            | { sandbox?: { backend?: string } }
            | undefined
        )?.sandbox?.backend ?? "snapshot";
      return JSON.stringify({ ...sandbox, backend }, null, 2);
    },
  };
}

/**
 * `sandbox_list` (the 2026-10-08 audit's P2-18).
 *
 * The model could not see the sandboxes that exist: create/write/execute/
 * diff/merge/rollback/delete all take an id, and nothing enumerated them — so
 * a model could not tell which sandboxes were its own, which were left over,
 * or that a workspace had accumulated 14 of them (56MB) with no way to notice.
 * This is the read face of the family, over the manager's own list.
 */
function sandboxListTool(): RuntimeTool {
  return {
    name: "sandbox_list",
    description:
      "List this workspace's sandboxes: each id, when it was created, whether it has unmerged changes and how many files, and whether it is running resources. Read-only.",
    requiresApproval: false,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    output: sandboxToolCard({
      title: "family",
      callSummary: "list",
      kind: "generic",
      resultSummary: (facts) =>
        facts.total === undefined
          ? "listed"
          : `${facts.total} sandbox${facts.total === 1 ? "" : "s"}`,
      facets: (facts) => [
        ...(facts.total === undefined
          ? []
          : [pill("total", String(facts.total))]),
        ...(facts.unmerged === undefined || facts.unmerged === 0
          ? []
          : [pill("unmerged", String(facts.unmerged))]),
      ],
    }),
    async execute(_input, context) {
      const manager = requireSandboxes(context);
      const sandboxes = await manager.list();
      // The list is the reading: one line per sandbox, with the two facts a
      // reader acts on — does it hold unmerged work, and is anything running
      // inside it. `changedFiles` itself stays on the raw answer for a
      // caller that wants the paths.
      const rows = sandboxes.map((sandbox) => ({
        id: sandbox.id,
        isolationLevel: sandbox.isolationLevel,
        changedFiles: sandbox.changedFiles.length,
        runningResources: sandbox.runningResources.length,
      }));
      return JSON.stringify({ total: rows.length, sandboxes: rows }, null, 2);
    },
  };
}

function sandboxExecuteTool(): RuntimeTool {
  return {
    name: "sandbox_execute",
    description: "Execute a shell command inside a TS workspace sandbox.",
    requiresApproval: true,
    parameters: {
      type: "object",
      properties: { id: { type: "string" }, command: { type: "string" } },
      required: ["id", "command"],
      additionalProperties: false,
    },
    output: sandboxToolCard({
      title: "command",
      callSummary: "execute",
      kind: "terminal",
      command: true,
      exit: true,
      text: true,
      resultSummary: (facts) =>
        facts.exitCode === undefined
          ? "executed"
          : facts.exitCode === 0
            ? "exit 0"
            : `exit ${facts.exitCode}`,
      facets: (facts) =>
        facts.exitCode === undefined
          ? []
          : [pill("exit", String(facts.exitCode))],
    }),
    async execute(input, context) {
      const args = requireObject(input);
      const manager = requireSandboxes(context);
      const id = requireString(args.id, "id");
      const result = await manager.execute(
        id,
        requireString(args.command, "command"),
        {
          signal: context.signal,
        },
      );
      context.onSandboxEvent?.(manager.updateEvent(id));
      context.onSandboxEvent?.(manager.auditEvent(id, "execute"));
      return [`exit=${result.exitCode}`, result.output].join("\n");
    },
  };
}

function sandboxWriteTool(): RuntimeTool {
  return {
    name: "sandbox_write",
    description: "Write a file inside a TS workspace sandbox manifest.",
    requiresApproval: true,
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["id", "path", "content"],
      additionalProperties: false,
    },
    output: sandboxToolCard({
      title: "id",
      callSummary: "write",
      resultSummary: (facts) => (facts.path ? `wrote ${facts.path}` : "wrote"),
      facets: (facts) => (facts.path ? [pill("path", facts.path)] : []),
    }),
    async execute(input, context) {
      const args = requireObject(input);
      const manager = requireSandboxes(context);
      const id = requireString(args.id, "id");
      await manager.write(
        id,
        requireString(args.path, "path"),
        requireString(args.content, "content"),
      );
      context.onSandboxEvent?.(manager.updateEvent(id));
      context.onSandboxEvent?.(manager.diffEvent(id));
      return `wrote ${requireString(args.path, "path")} in sandbox ${id}`;
    },
  };
}

function sandboxDiffTool(): RuntimeTool {
  return sandboxReadTool(
    "sandbox_diff",
    "Show pending sandbox changes.",
    async (manager, id) => {
      const changes = await manager.previewMerge(id);
      return JSON.stringify(changes, null, 2);
    },
  );
}

function sandboxMergeTool(): RuntimeTool {
  return {
    name: "sandbox_merge",
    description: "Merge a sandbox manifest into the current workspace.",
    requiresApproval: true,
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        maxLines: { type: "number" },
        // P0-2: the validation command, as a caller-supplied override. The
        // 2026-10-08 audit found a CMake workspace could never promote —
        // the gate's contract is exactly `npm run typecheck` plus a
        // package.json, with no parameter to say otherwise, while
        // `team_review` has carried one all along.
        buildCommand: {
          type: "string",
          description:
            "The command that verifies this project, run in the workspace root before the merge lands. " +
            "Omit it and the workspace's own project marker decides (package.json -> npm run typecheck, " +
            "CMakeLists.txt -> cmake, Cargo.toml -> cargo check, pyproject.toml -> compileall); " +
            "a workspace with no marker needs either this or `sandbox.promoteCommand`.",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    output: sandboxToolCard({
      title: "id",
      callSummary: "merge",
      kind: "diff",
      hunks: true,
      resultSummary: (facts) =>
        facts.total === undefined
          ? "merged"
          : `merged ${facts.total} file${facts.total === 1 ? "" : "s"}`,
      facets: (facts) => [
        ...(facts.total === undefined
          ? []
          : [pill("files", String(facts.total))]),
        ...(facts.additions === undefined
          ? []
          : [pill("added", String(facts.additions))]),
        ...(facts.deletions === undefined
          ? []
          : [pill("removed", String(facts.deletions))]),
      ],
    }),
    async execute(input, context) {
      const args = requireObject(input);
      const id = requireString(args.id, "id");
      const manager = requireSandboxes(context);
      // The validation command, in one honest order: the configured
      // `sandbox.promoteCommand` wins; otherwise the workspace's own project
      // markers decide; a workspace with neither gets a refusal that says
      // what to set, because a blind fallback validates the merge against
      // the wrong toolchain (T-09: a CMake project checked by
      // `npm run typecheck`).
      const configured = (
        context.runtimeConfig?.() as
          | { sandbox?: { promoteCommand?: string } }
          | undefined
      )?.sandbox?.promoteCommand?.trim();
      // P0-2: an explicit `buildCommand` outranks the configured default and
      // the marker, the way `team_review`'s per-PR command does. A caller
      // that names the project's own toolchain gets its merge validated by
      // it; the marker still decides when nobody says.
      const explicit =
        typeof args.buildCommand === "string" && args.buildCommand.trim()
          ? args.buildCommand.trim()
          : undefined;
      const command =
        explicit ??
        configured ??
        detectPromoteCommand(context.workspaceRoot)?.command;
      if (!command)
        throw new Error(
          "sandbox_merge needs a validation command for this workspace: " +
            "no project marker (" +
            PROMOTE_MARKERS.map((marker) => marker.file).join(", ") +
            ") was found under " +
            context.workspaceRoot +
            ", and `sandbox.promoteCommand` is not configured. " +
            "Set sandbox.promoteCommand to the command that verifies this " +
            "project (it runs in the workspace root before the merge lands).",
        );
      const promotion = await manager.promoteWithValidation(id, {
        command,
        hostRoot: context.workspaceRoot,
        authorize: async (paths) =>
          await context.sandboxMergeAuthorize?.({
            id,
            paths,
          }),
      });
      const changes = promotion.changedFiles;
      context.onWorkspaceChange?.(changes);
      context.onSandboxEvent?.(manager.updateEvent(id));
      context.onSandboxEvent?.(manager.auditEvent(id, "merge"));
      // F2 (2026-10-10 sweep): the answer was `JSON.stringify(changes, null,
      // 2)` with NO cap — one added file produced 117 pages / 5.87 MB, and a
      // sweep wrote ~11.9 MB of spill into `.natalia/tool-output/`. The tool
      // declares `maxLines` and never read it. The cap is the answer's, and
      // it says when it cut.
      const requested = args.maxLines;
      const maxLines = Math.max(
        1,
        Math.min(
          500,
          typeof requested === "number" && Number.isFinite(requested)
            ? Math.floor(requested)
            : MERGE_MAX_LINES,
        ),
      );
      const full = JSON.stringify(changes, null, 2);
      const bounded = boundedText(full, MERGE_MAX_BYTES);
      const lines = bounded.body.split("\n");
      if (lines.length <= maxLines && !bounded.truncated) return bounded.body;
      const kept = lines.slice(0, maxLines).join("\n");
      const hidden = lines.length - maxLines;
      return [
        kept,
        `... ${hidden} more line(s) omitted; ${changes.length} file(s) changed, ${bounded.totalBytes} bytes total.`,
        "Pass maxLines for more, or read a file directly — the merge already landed.",
      ].join("\n");
    },
  };
}

/**
 * Undoes one sandbox's promotion.
 *
 * Exposed as a tool because the promotion is: a capability the runtime publishes
 * in its completion record (`rollbackState`) is only honest if something can act
 * on it. It rewrites host files, so it clears the same authorization gate as the
 * merge it undoes.
 */
function sandboxRollbackTool(): RuntimeTool {
  return {
    name: "sandbox_rollback",
    description:
      "Undo a sandbox's promotion and restore the host to what it was before. Refuses when a later promotion has touched the same paths, since undoing would discard newer work.",
    requiresApproval: true,
    parameters: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    output: sandboxToolCard({
      title: "id",
      callSummary: "rollback",
      resultSummary: (facts) =>
        facts.reason
          ? `refused: ${facts.reason}`
          : facts.restored === true
            ? "restored"
            : "nothing to restore",
      facets: (facts) => [
        ...(facts.restored === true ? [pill("restored", "true")] : []),
        ...(facts.reason ? [pill("reason", facts.reason)] : []),
      ],
    }),
    async execute(input, context) {
      const args = requireObject(input);
      const id = requireString(args.id, "id");
      const manager = requireSandboxes(context);
      const diff = await manager.previewMerge(id);
      const paths = diff.map((change) => change.path);
      await context.sandboxMergeAuthorize?.({ id, paths });
      const result = await manager.rollback(id);
      context.onWorkspaceChange?.(
        diff.map((change) => ({ ...change, kind: "modify" as const })),
      );
      context.onSandboxEvent?.(manager.updateEvent(id));
      context.onSandboxEvent?.(manager.auditEvent(id, "rollback"));
      return JSON.stringify(
        {
          id,
          restored: result.restored,
          restoredPaths: result.restored ? paths : [],
          // T-11: a refusal that says nothing reads as a mute backend. The
          // reason names the obstacle — no rollback point, or one that
          // belongs to a later promotion.
          ...(result.reason ? { reason: result.reason } : {}),
        },
        null,
        2,
      );
    },
  };
}

function sandboxDeleteTool(): RuntimeTool {
  return {
    name: "sandbox_delete",
    description:
      "Delete a TS workspace sandbox. The answer names what the deletion discarded: `deleted`, `discardedChanges` and `discardedPaths` — a sandbox with pending (unmerged) changes has that work destroyed here, not merged.",
    requiresApproval: true,
    parameters: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    output: sandboxToolCard({
      title: "id",
      callSummary: "delete",
      resultSummary: (facts) =>
        facts.discardedChanges && facts.discardedChanges > 0
          ? `deleted · discarded ${facts.discardedChanges} change${facts.discardedChanges === 1 ? "" : "s"}`
          : "deleted",
      facets: (facts) => [
        ...(facts.deleted === undefined ? [] : [pill("deleted", "true")]),
        ...(facts.discardedChanges === undefined
          ? []
          : [pill("discarded", String(facts.discardedChanges))]),
      ],
    }),
    async execute(input, context) {
      const id = requireString(requireObject(input).id, "id");
      const manager = requireSandboxes(context);
      const result = await manager.delete(id);
      context.onSandboxEvent?.({
        type: "sandbox.update",
        id,
        status: "deleted",
        root: "",
        isolationLevel: "workspace",
        changedFiles: result.pendingChanges.length,
        runningResources: result.runningResources.length,
        target: { kind: "host", cwd: context.workspaceRoot },
        resourcePolicy: "sandbox deleted after resource cleanup",
      });
      context.onSandboxEvent?.({
        type: "sandbox.audit",
        id,
        action: "delete",
        target: { kind: "host", cwd: context.workspaceRoot },
        approvalRequired: true,
        checkpointPolicy: "sandbox_manifest",
        message: "Sandbox workspace directory deleted after resource cleanup.",
      });
      return JSON.stringify(result, null, 2);
    },
  };
}

function sandboxResourceStartTool(): RuntimeTool {
  return {
    name: "sandbox_resource_start",
    description:
      "Start a managed background process inside a TS workspace sandbox.",
    requiresApproval: true,
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        command: { type: "string" },
        resourceID: { type: "string" },
      },
      required: ["id", "command"],
      additionalProperties: false,
    },
    output: sandboxToolCard({
      title: "command",
      callSummary: "start resource",
      kind: "terminal",
      command: true,
      resultSummary: (facts) =>
        facts.resourceID ? `started ${facts.resourceID}` : "started",
      facets: (facts) => [
        ...(facts.resourceID ? [pill("resource", facts.resourceID)] : []),
        ...(facts.pid === undefined ? [] : [pill("pid", String(facts.pid))]),
      ],
    }),
    async execute(input, context) {
      const args = requireObject(input);
      const manager = requireSandboxes(context);
      const id = requireString(args.id, "id");
      const resource = await manager.startResource(
        id,
        requireString(args.command, "command"),
        optionalString(args.resourceID),
      );
      context.onSandboxEvent?.(manager.updateEvent(id));
      context.onSandboxEvent?.(manager.auditEvent(id, "resource_start"));
      return JSON.stringify(resource, null, 2);
    },
  };
}

function sandboxResourceListTool(): RuntimeTool {
  return sandboxResourceReadTool(
    "sandbox_resource_list",
    "List managed processes running inside a TS workspace sandbox.",
    (manager, id) => JSON.stringify(manager.resourcesFor(id), null, 2),
  );
}

function sandboxResourceOutputTool(): RuntimeTool {
  return {
    name: "sandbox_resource_output",
    description: "Read retained output from a managed sandbox process.",
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: { id: { type: "string" }, resourceID: { type: "string" } },
      required: ["id", "resourceID"],
      additionalProperties: false,
    },
    output: sandboxToolCard({
      title: "id",
      callSummary: "resource output",
      kind: "terminal",
      text: true,
      resultSummary: () => "read",
    }),
    async execute(input, context) {
      const args = requireObject(input);
      return await requireSandboxes(context).resourceOutput(
        requireString(args.id, "id"),
        requireString(args.resourceID, "resourceID"),
      );
    },
  };
}

function sandboxResourceStopTool(): RuntimeTool {
  return {
    name: "sandbox_resource_stop",
    description:
      "Stop a managed process running inside a TS workspace sandbox.",
    requiresApproval: true,
    parameters: {
      type: "object",
      properties: { id: { type: "string" }, resourceID: { type: "string" } },
      required: ["id", "resourceID"],
      additionalProperties: false,
    },
    output: sandboxToolCard({
      title: "id",
      callSummary: "stop resource",
      resultSummary: (facts) =>
        facts.status ? `stopped · ${facts.status}` : "stopped",
      facets: (facts) => [
        ...(facts.resourceID ? [pill("resource", facts.resourceID)] : []),
        ...(facts.exitCode === undefined
          ? []
          : [pill("exit", String(facts.exitCode))]),
      ],
    }),
    async execute(input, context) {
      const args = requireObject(input);
      const manager = requireSandboxes(context);
      const id = requireString(args.id, "id");
      const resource = await manager.stopResource(
        id,
        requireString(args.resourceID, "resourceID"),
      );
      context.onSandboxEvent?.(manager.updateEvent(id));
      context.onSandboxEvent?.(manager.auditEvent(id, "resource_stop"));
      return JSON.stringify(resource, null, 2);
    },
  };
}

function sandboxResourceReadTool(
  name: string,
  description: string,
  action: (manager: SandboxToolService, id: string) => string,
): RuntimeTool {
  return {
    name,
    description,
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    output: sandboxToolCard({
      title: "id",
      callSummary: name === "sandbox_resource_list" ? "list resources" : "read",
      resultSummary: (facts) =>
        facts.total === undefined
          ? "read"
          : `${facts.total} resource${facts.total === 1 ? "" : "s"}`,
      facets: (facts) =>
        facts.total === undefined ? [] : [pill("total", String(facts.total))],
    }),
    async execute(input, context) {
      return action(
        requireSandboxes(context),
        requireString(requireObject(input).id, "id"),
      );
    },
  };
}

function sandboxReadTool(
  name: string,
  description: string,
  action: (manager: SandboxToolService, id: string) => Promise<string>,
  requiresApproval = false,
): RuntimeTool {
  return {
    name,
    description,
    requiresApproval,
    parameters: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    output: sandboxToolCard({
      title: "id",
      callSummary: name === "sandbox_diff" ? "diff" : "read",
      kind: "diff",
      hunks: true,
      resultSummary: (facts) =>
        facts.total === undefined
          ? "read"
          : `${facts.total} change${facts.total === 1 ? "" : "s"}`,
      facets: (facts) => [
        ...(facts.total === undefined
          ? []
          : [pill("files", String(facts.total))]),
        ...(facts.additions === undefined
          ? []
          : [pill("added", String(facts.additions))]),
        ...(facts.deletions === undefined
          ? []
          : [pill("removed", String(facts.deletions))]),
      ],
    }),
    async execute(input, context) {
      return await action(
        requireSandboxes(context),
        requireString(requireObject(input).id, "id"),
      );
    },
  };
}

/** Every sandbox tool. */
export function sandboxTools(): RuntimeTool[] {
  return [
    sandboxCreateTool(),
    sandboxListTool(),
    sandboxExecuteTool(),
    sandboxWriteTool(),
    sandboxDiffTool(),
    sandboxMergeTool(),
    sandboxRollbackTool(),
    sandboxDeleteTool(),
    sandboxResourceStartTool(),
    sandboxResourceListTool(),
    sandboxResourceOutputTool(),
    sandboxResourceStopTool(),
  ];
}

/**
 * Workspace scope: a sandbox is a copy of the workspace, and its tools are only
 * meaningful while that workspace is mounted.
 */
export function sandboxToolFamily(): ToolFamily {
  return {
    id: "sandbox",
    name: "Sandbox Tools",
    version: "1.0.0",
    description: "Isolated workspaces and their merge back.",
    scope: "workspace",
    tools: [...sandboxTools()],
  };
}
