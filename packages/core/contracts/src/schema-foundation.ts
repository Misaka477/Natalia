import { z } from "zod";

export const outputTokenLimitSchema = z
  .number()
  .int()
  .positive()
  .nullable()
  .optional();

export const timeoutSchema = z.object({
  requestSec: z.number().int().min(0).default(0),
  streamIdleSec: z.number().int().min(0).default(0),
  toolSec: z.number().int().positive().optional(),
  turnSec: z.number().int().positive().nullable().default(null),
});

/**
 * How the native terminal window is opened for a foreground session.
 * Deployment driven: a headless server has no display, so the pane must run
 * windowless (the model still reads and writes it; only the human window is
 * missing). `auto` is the default — it attempts a window and, when the attach
 * fails (no display, stale DISPLAY, transient first-run failure), degrades to
 * windowless instead of rolling the started terminal back.
 */
export const terminalWindowConfigSchema = z.object({
  windowMode: z.enum(["auto", "windowless", "window"]).default("auto"),
  /**
   * The terminal backend. The WezTerm fork is gone (the user's decision,
   * 2026-10-04): the interactive terminal is the self-developed stack — an
   * in-process document, the platform's PTY bridge (the Rust bridge on POSIX,
   * the ConPTY bridge on Windows), the web panel's xterm renderer. There is
   * one value now, and it is what the runtime always used.
   *
   * The value stays in the schema rather than being dropped because an old
   * config that says `"wezterm"` must still PARSE: a missing field on a
   * required key is a parse error, and a user's existing config is not the
   * place to teach them the retirement. The controller behind the value no
   * longer exists, so anything asking for it gets the pty backend — the
   * document is honest about there being no other answer.
   */
  backend: z.literal("pty").default("pty"),
  /**
   * Minutes an exited pane must stay idle before `interactive_terminal_cleanup`
   * reclaims it (P2-19). `0` means "reclaim any exited pane on the next
   * cleanup". The 2026-10-08 audit found the terminal family had no cleanup
   * at all, so exited panes accumulated in `list` forever — its own session
   * still showed two at the end.
   */
  maxIdleMinutes: z.number().min(0).default(60),
});

/**
 * The shell-runtime settings. `bashPath` is WINDOWS-ONLY by design: on
 * Linux and macOS the shell is `bash` and no setting is needed, so the
 * resolver ignores this field off Windows (a row that does nothing on two
 * of three platforms is noise). Windows uses it because the discovery
 * sees only the four default roots and the PATH — a Git for Windows
 * installed elsewhere (D:\tools\Git, a portable install) had no answer
 * but an environment variable, and an env var is not a persisted
 * configuration. Empty means "discover".
 */
export const shellConfigSchema = z.object({
  bashPath: z.string().max(1024).optional(),
});

export const teamConfigSchema = z.object({
  /**
   * The maximum number of sandboxed sub-agents a fan-out may run concurrently.
   * More parallelism is faster but costs more provider tokens and sandbox
   * disk; the provider-concurrency limiter is the hard ceiling underneath.
   */
  maxConcurrent: z.number().int().min(1).max(32).default(4),
});

export const sandboxConfigSchema = z.object({
  /**
   * Which sandbox backend is the default. `snapshot` is our own git-free
   * backend (content-addressed object store, candidate/promote/rollback) and
   * needs nothing external; `worktree` uses the host's real git when the
   * workspace is a git repo, so a promoted sandbox change lands as a commit in
   * the user's own history. Default `snapshot`: the framework ships its own
   * git, git is opt-in for history integration.
   */
  backend: z.enum(["snapshot", "worktree"]).default("snapshot"),
  /**
   * Command run inside the candidate before a promote may land. Empty is
   * rejected; the runtime never promotes on a silent no-op command.
   */
  promoteCommand: z.string().trim().min(1).default("npm run typecheck"),
  /**
   * Hours after which an untouched sandbox is garbage (P2-18). `0` disables
   * it — the collection is opt-out, not opt-in, because the 2026-10-08 audit
   * found a workspace carrying 14 stale sandboxes (56MB) that nothing could
   * see or reclaim. A sandbox with UNMERGED changes is never collected: that
   * is a reader's unfinished work, not garbage.
   */
  maxIdleHours: z.number().min(0).default(168),
  /**
   * How many sandboxes may exist before the oldest CLEAN one is collected on
   * the next create. `0` means no cap.
   */
  maxSandboxes: z.number().min(0).default(0),
});

/** The three-mode file axis (sandbox study §3 item 1, decision 25). */
export const CONFINEMENT_MODES = [
  "read-only",
  "workspace-write",
  "danger-full-access",
] as const;

/**
 * Execution confinement for tool subprocesses — the FILE-effect axis, kept
 * apart from the permission mode (the approval axis): a write that confinement
 * allows may still need human approval, and the two resolve independently
 * per call (sandbox study §3, the two-axis clarification).
 *
 * `workspace-write` as the shipped default is the threat model speaking:
 * `runShell` gets Landlock-level L1 enforcement for everything the agent
 * executes, with `/tmp` and the workspace writable and the rest of the
 * filesystem read-only. A deployment that wants the old unconstrained
 * behavior opts into `danger-full-access` explicitly.
 */
export const confinementConfigSchema = z.object({
  mode: z.enum(CONFINEMENT_MODES).default("workspace-write"),
});

/** The backend seam takes no config: the selection IS the impl id.
 * An empty schema keeps the codegen's config type an honest `{}` (an
 * editor sees no keys, not `unknown`). */
export const objectStoreConfigSchema = z.object({});

/**
 * The composition-profile row that carries the confinement default
 * (interface spec §6.8's `anthelia.sandbox` row). One name for the
 * shipped `composition.base.json`, the registrar, and the
 * tool-execution consumer — the profile freshness test keeps the file
 * and the code in step.
 */
export const CONFINEMENT_COMPOSITION_ROW_ID = "anthelia.sandbox";
/** The object-store backend seam (decision17: the row SELECTS the
 * factory — absence means the TypeScript implementation, `rust` demands
 * the native core with the same honest availability fallback the env
 * seam has). */
export const OBJECTSTORE_COMPOSITION_ROW_ID = "anthelia.objectstore";

/**
 * Wall-clock budget for one subagent run, in milliseconds.
 *
 * Bounds a run that is stuck rather than merely slow: a provider call that
 * never returns, or a step that takes minutes. Without it such a run continues
 * until the session ends, paying for every step it takes. `0` disables the
 * budget.
 *
 * The budget is per run, not per subagent: each retry is a deliberate new run
 * with its own budget, so an operator who retries is choosing to spend again.
 */
export const subagentWallClockMs = z.number().int().min(0).default(900_000);

/**
 * Goal completion verification.
 *
 * A goal used to be complete because whoever reported it said so, which put the
 * authority entirely in the model's own claim. `command` makes that claim
 * checkable: it runs before a *model-initiated* completion is accepted, and a
 * non-zero exit refuses the completion with the exit code and output so the
 * model can see why.
 *
 * Empty by default. A workspace that does not configure a check behaves exactly
 * as before — an invented default command would fail every workspace that has no
 * test suite, and a silently passing one would be theatre.
 */
export const goalConfigSchema = z
  .object({
    completionCommand: z.string().trim().min(1).optional(),
  })
  .strict();

export const runtimeConfigSchema = z.object({
  maxStepsPerTurn: z.number().int().positive().optional(),
  subagentDepth: z.number().int().min(1).max(8).default(1),
  /** Milliseconds one subagent run may take before the runtime stops it. */
  subagentWallClockMs: subagentWallClockMs,
  /**
   * Shortest acceptable final answer from a subagent. A shorter one is followed
   * by exactly one turn asking for the missing detail.
   *
   * `0` disables the gate. The parent receives only the subagent's final text,
   * so a one-word answer leaves it with nothing to act on and no way to tell
   * that from a complete one.
   */
  subagentMinResultChars: z.number().int().min(0).default(200),
  /**
   * Settled-outcome notices one session's ledger will carry.
   *
   * A subagent settles whenever it likes and the turn that spawned it is usually
   * elsewhere by then, so the outcome is written into the ledger as runtime
   * context instead of left for the parent to poll for. The number is a budget
   * because each notice is context the parent pays for on every later request,
   * and a session that delegates a great deal must not have its prompt consumed
   * by its own bookkeeping. Each notice is deduplicated per subagent and
   * continuation, so the cap is on distinct children, not on re-settles.
   */
  subagentSettledNotices: z
    .number()
    .int()
    .min(0)
    .refine((value) => value === 0 || Number.isFinite(value), {
      message: "must be a non-negative integer",
    })
    .default(20),
  collaboration: z
    .object({
      /**
       * Maximum request/reply exchanges Natalia and Navi may continue without
       * another user turn. A reply that closes the final exchange is always
       * delivered; this limit only prevents another automatic follow-up.
       */
      maxAutoRounds: z.number().int().min(1).max(10).default(3),
      /**
       * The model Navi consults with when Natalia asks her mid-task (the
       * advisor path). ABSENT by default: a consult runs on Navi's chat
       * model — the same family as the main agent's — because the
       * advisor's value is an INDEPENDENT second read (a fresh context
       * with no sunk-cost commitment, adversarial framing), not a
       * capability tier. Set it only when a second provider or tier is
       * worth the difference. A session's own expert-profile selection
       * (the model command) overrides this default.
       */
      advisorModel: z.string().min(1).optional(),
    })
    .default({}),
  timeouts: timeoutSchema.default({}),
  maxAttemptsPerStep: z.number().int().positive().optional(),
  /**
   * Max in-flight provider requests per provider id, keyed by provider. This is
   * the fan-out ceiling: N parallel sub-agents each take a slot before calling
   * the provider, so they queue instead of tripping rate limits. Absent =
   * unlimited.
   */
  providerConcurrency: z.record(z.number().int().min(1)).default({}),
  retry: z
    .object({
      // Null means transient provider failures retry until success or cancellation.
      maxAttemptsPerStep: z.number().int().positive().nullable().default(null),
      initialBackoffMs: z.number().int().positive().default(300),
      maxBackoffMs: z.number().int().positive().default(5000),
      jitterMs: z.number().int().min(0).default(500),
    })
    .default({}),
  terminal: terminalWindowConfigSchema.default({}),
  shell: shellConfigSchema.default({}),
});

export const contextConfigSchema = z.object({
  autoDetectWindow: z.boolean().default(true),
  compactionEnabled: z.boolean().default(true),
  /**
   * The user's own instruction, layered onto every compaction prompt.
   *
   * A workspace often knows what a summary must keep that a generic one would
   * drop — changelog dates, ticket ids, which test names matter. This is where
   * that goes, rather than each stream hardcoding its own version of it.
   *
   * Absent by default: an invented instruction would be a guess at what the
   * workspace cares about.
   */
  customInstruction: z.string().trim().min(1).optional(),
  compactionThresholdPercent: z.number().int().min(50).max(99).default(85),
  reservedOutputTokens: z
    .union([z.literal("auto"), z.number().int().positive()])
    .default("auto"),
  preservedRecentMessages: z.number().int().min(0).default(10),
  /** When > 0, an absolute token budget for the recent tail. */
  /**
   * Recent-context tokens always kept verbatim across a compaction.
   *
   * A floor rather than a ceiling: the preserved tail is whichever of this and
   * `preservedRecentMessages` reaches further back. Sized in the 15k–20k range
   * the other agent harnesses settle on, because a count alone cannot say how
   * much context a turn holds: ten short exchanges and ten file reads are the
   * same count and an order of magnitude apart in tokens.
   */
  preservedRecentTokens: z.number().int().min(0).default(20_000),
  /** Bounded overflow recovery attempts before surfacing context_limit. */
  maxOverflowRetries: z.number().int().min(0).max(3).default(1),
});

export const checkpointConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    maxFiles: z.number().int().positive().default(20000),
    maxBytes: z
      .number()
      .int()
      .positive()
      .default(512 * 1024 * 1024),
    ignore: z.array(z.string()).default([]),
    additionalDirs: z.array(z.string()).default([]),
  })
  .default({});

/**
 * The background self-review loop (Discovery D4): after each turn a
 * side-channel review replays a session digest and may sediment skills
 * through the validated write boundary. Default ON, fail-open at the
 * scheduler's read (a broken config must never silently disable the
 * loop — a warning keeps the cost visible), mirroring hermes'
 * background_review.enabled contract.
 */
export const backgroundReviewConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
  })
  .default({});

export const interleavedReasoningCapabilitySchema = z.union([
  z.literal(true),
  z.literal(false),
  z.object({
    field: z.enum(["reasoning", "reasoning_content", "reasoning_details"]),
  }),
]);

export const modelCapabilitiesSchema = z.object({
  toolCall: z.boolean().default(true),
  reasoning: z.boolean().default(true),
  thinking: z.boolean().default(true),
  imageInput: z.boolean().default(false),
  videoInput: z.boolean().default(false),
  /**
   * OpenAI-compatible providers that expect reasoning to be carried in a
   * dedicated message field across turns. `false` disables the behavior even
   * for models whose id otherwise looks interleaved. An omitted value lets the
   * adapter use its built-in provider default.
   */
  interleaved: interleavedReasoningCapabilitySchema.optional(),
});

export const modelLimitsSchema = z
  .object({
    contextWindow: z
      .union([z.literal("auto"), z.number().int().positive()])
      .default("auto"),
    maxOutputTokens: outputTokenLimitSchema,
    /** Optional provider/model input ceiling; falls back to contextWindow. */
    inputLimit: z.number().int().positive().optional(),
    /** Optional per-model output reserve override. */
    reservedOutputTokens: z.number().int().positive().optional(),
    /** Optional per-model compaction threshold override. */
    compactionThresholdPercent: z.number().int().min(50).max(99).optional(),
  })
  .default({});

/**
 * A model known to a provider, keyed by the model ID the provider's API
 * returns. The catalog is where provider-returned facts live (discovery or
 * user-declared manual import); it is never mutated by a runtime default.
 */
export const catalogModelSchema = z.object({
  name: z.string().min(1),
  capabilities: modelCapabilitiesSchema.default({}),
  limits: modelLimitsSchema,
  status: z.enum(["stable", "experimental", "deprecated"]).default("stable"),
  source: z.enum(["discovery", "manual"]).default("discovery"),
});

/**
 * The provider-visible model catalog. `catalog.providers[providerID].models`
 * is keyed by the provider's own model ID, so the same model string on two
 * providers never collides.
 */
export const modelCatalogSchema = z
  .object({
    providers: z
      .record(
        z
          .object({
            models: z.record(catalogModelSchema).default({}),
          })
          .default({}),
      )
      .default({}),
  })
  .default({});

export const providerConnectionSchema = z
  .object({
    baseURL: z.string().url().optional(),
    apiKey: z.string().min(1).optional(),
    authHeader: z.string().optional(),
  })
  .default({});

export const providerRequestDefaultsSchema = z
  .object({
    stream: z.boolean().default(true),
    headers: z.record(z.string()).default({}),
    options: z.record(z.unknown()).default({}),
  })
  .default({});

/**
 * A configured provider, keyed by a stable provider ID. `name` is the
 * user-editable label; `driver` names the wire protocol adapter. Connection
 * secrets and request-level defaults are nested so a partial overlay can
 * update one without replacing the others.
 */
/**
 * How an endpoint speaks to its provider.
 *
 * `format` names the wire format and is the only thing that selects an adapter.
 * It is optional so an existing configuration keeps loading, but the loader
 * warns with the exact JSON to add: a format inferred from `driver` is a guess
 * about what a human meant to type, and the adapter seam exists precisely so
 * that choice is declared instead of guessed.
 */
/**
 * Optional cache extensions an endpoint declares it accepts.
 *
 * Every field is optional and every absent one means off: an undeclared
 * capability costs one unused optimisation, while an assumed one makes every
 * request fail against a parameter the deployment never accepted.
 */
export const endpointCapabilitiesSchema = z
  .object({
    supportsLongCacheRetention: z.boolean().optional(),
    supportsCacheControlOnTools: z.boolean().optional(),
    sendSessionAffinityHeaders: z.boolean().optional(),
    sessionAffinityFormat: z.enum(["openrouter"]).optional(),
    supportsPromptCacheKey: z.boolean().optional(),
    promptCacheKeyField: z
      .enum(["promptCacheKey", "prompt_cache_key"])
      .optional(),
    supportsExplicitPromptCacheMode: z.boolean().optional(),
  })
  .strict();

export const endpointProtocolSchema = z
  .object({
    format: z.string().min(1).optional(),
    /**
     * Local module exporting the adapter for a custom format, resolved against
     * the workspace root. Present only for formats this package does not ship;
     * the built-in families need no module.
     */
    module: z.string().min(1).optional(),
    /** Declared optional cache extensions; absent means none are used. */
    capabilities: endpointCapabilitiesSchema.optional(),
    /**
     * How long this endpoint's prompt cache should be retained. A preference,
     * not a capability: asking for `long` on an endpoint that has not declared
     * `supportsLongCacheRetention` degrades to `short` rather than failing.
     */
    cacheRetention: z.enum(["none", "short", "long"]).optional(),
  })
  .strict();

export const providerConfigSchema = z.object({
  name: z.string().min(1),
  driver: z.string().min(1),
  enabled: z.boolean().default(true),
  connection: providerConnectionSchema,
  requestDefaults: providerRequestDefaultsSchema,
  protocol: endpointProtocolSchema.optional(),
});

export const modelOverrideRequestDefaultsSchema = z
  .object({
    temperature: z.number().min(0).max(2).nullable().default(null),
    topP: z.number().min(0).max(1).nullable().default(null),
    // Optional on purpose: an unset field falls through to the provider's
    // connection-level request default instead of being pinned to `true`.
    stream: z.boolean().optional(),
    thinkingEnabled: z.boolean().optional(),
  })
  .default({});

/**
 * User intent layered over the catalog. Keyed by the canonical
 * `${providerID}/${modelID}` ref, so a user can enable, rename or tune a
 * specific model without rewriting provider-returned catalog facts.
 */
export const modelOverrideSchema = z.object({
  enabled: z.boolean().default(true),
  name: z.string().min(1).optional(),
  requestDefaults: modelOverrideRequestDefaultsSchema,
  requestOptions: z.record(z.unknown()).default({}),
  headers: z.record(z.string()).default({}),
  limits: modelLimitsSchema.optional(),
});

/** A canonical model reference: `{provider, model}`. */
export const modelRefSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
  })
  .strict();

export function modelRefKey(ref: { provider: string; model: string }): string {
  return `${ref.provider}/${ref.model}`;
}

export function parseModelRef(input: string): {
  provider: string;
  model: string;
} {
  const separator = input.indexOf("/");
  if (separator <= 0 || separator === input.length - 1)
    throw new Error(
      `invalid model reference "${input}"; expected "provider/model"`,
    );
  return {
    provider: input.slice(0, separator),
    model: input.slice(separator + 1),
  };
}

export const modeConfigSchema = z.object({
  description: z.string().default(""),
  model: z.string().optional(),
  permission: z.string().optional(),
  systemPrompt: z.string().default(""),
  allowedTools: z.array(z.string()).default([]),
  excludedTools: z.array(z.string()).default([]),
  mcpServers: z.array(z.string()).default([]),
});
