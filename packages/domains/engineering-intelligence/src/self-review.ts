import type { RuntimeEvent } from "@anthelia/contracts";
import type { SkillService, SkillMetadata } from "@anthelia/runtime-services";
import type {
  ProviderStreamRequest,
  StreamingProvider,
} from "@anthelia/runtime";

/**
 * Discovery D4 — the side-channel self-review loop (hermes'
 * agent/background_review.py paradigm, its four disciplines held):
 *
 *  1. AFTER each turn, replay a BOUNDED digest of the session snapshot
 *     and ask "should any skill be sedimented?" — the review is a
 *     separate completion, never a turn of the main conversation;
 *  2. the main conversation and its prompt cache are NEVER touched
 *     (this module only reads events and calls the provider directly);
 *  3. it inherits the session's live runtime — the SAME provider the
 *     turn used (captured FIRST, before any await — the title-loop
 *     race this repo already paid for once);
 *  4. the write surface is a WHITELIST: candidates may only
 *     create/update skills, enforced at the validated write boundary
 *     (SkillService.upsertSkill), never at prompt-time alone.
 *
 * Output contract: JSON only. Failures are honest edges
 * (self_review.skipped with a reason), never silent.
 */

/** Coarse input budget: a full turn-history digest is capped here. */
export const SELF_REVIEW_DIGEST_CHARS = 24_000;
/** Output budget: enough for a skill body, not an essay. */
export const SELF_REVIEW_OUTPUT_LIMIT = 12_000;
export const SELF_REVIEW_TIMEOUT_MS = 30_000;
/** How long after the turn the review fires (late enough to be after persistence). */
export const SELF_REVIEW_DELAY_MS = 400;

/**
 * The three-question review. The lane that was here first asks ① (what to
 * sediment for next time); the two the self-iteration loop was missing are
 * ② (what was DEFICIENT — the repair lane) and ③ (what capability was
 * MISSING that would have made this task better — the growth lane, the
 * plan's `growth.proposed` kind "tool"). A proposal is a FACT: recording
 * one applies nothing (the plan's approval policy — growth never
 * self-authorizes).
 */
const TASK_PROMPT = `You are a background curator for this workspace. You receive a skills catalog, a transcript digest, and (when the session produced them) the invariant violations it tripped. Answer three questions about the work just done.

Reply with ONLY a JSON object, no markdown fences, no commentary:
{"candidates":[{"kind":"create","name":"kebab-lowercase-name","description":"one line","content":"# markdown skill body"},{"kind":"update","name":"existing-skill","description":"one line","content":"# full replacement body"}],"deficiencies":[{"kind":"rule","capability":"short name","reason":"what went wrong, seen from the transcript"}],"aspirations":[{"kind":"tool","capability":"short name","reason":"what you reached for and it did not exist, or what would have made this task better"}]}

Rules:
- ① candidates: name = lowercase letters/digits/hyphens starting alphanumeric; content = complete markdown skill body. If nothing is worth sedimenting, [].
- ② deficiencies: kind is "rule" for something that should be a constitution rule, "policy" for a policy the runs keep losing to, "skill" for missing knowledge. Point at what the transcript SHOWS (a violation fact is the strongest evidence; a failure or a redo is next). [] when nothing was deficient.
- ③ aspirations: kind is "tool" for a new tool/capability the runtime does not have, "skill" for knowledge worth sedimenting as a skill. This is the growth lane — a capability you WISH existed after doing this work. [] when nothing was missing.
- Never propose deleting, executing, or writing anything outside these three lists. A proposal records an observation; it changes nothing by itself.`;

/** The honest digest: human turns, assistant replies, tool names — bounded. */
export function buildSelfReviewDigest(events: readonly RuntimeEvent[]): string {
  const lines: string[] = [];
  let assistant = "";
  const flushAssistant = () => {
    const text = assistant.trim();
    if (text) lines.push(`assistant: ${text.slice(0, 1_500)}`);
    assistant = "";
  };
  for (const event of events) {
    if (event.type === "turn.submitted") {
      if (event.internal) continue; // runtime choreography, not the work
      flushAssistant();
      lines.push(`user: ${event.text.trim().slice(0, 2_000)}`);
      continue;
    }
    if (event.type === "content.delta") {
      assistant += event.text;
      continue;
    }
    const toolName = (event as { toolName?: string }).toolName;
    if (toolName) {
      flushAssistant();
      lines.push(`tool: ${toolName}`);
      continue;
    }
    if (event.type === "turn.finished") flushAssistant();
  }
  flushAssistant();
  const digest = lines.join("\n");
  return digest.length > SELF_REVIEW_DIGEST_CHARS
    ? `…(truncated)…\n${digest.slice(-SELF_REVIEW_DIGEST_CHARS)}`
    : digest;
}

export function buildSelfReviewPrompt(
  digest: string,
  skills: readonly SkillMetadata[],
  violations: readonly unknown[] = [],
): { messages: ProviderStreamRequest["messages"] } {
  const catalog = skills
    .map((skill) => `- ${skill.name}: ${skill.description ?? ""}`.trim())
    .join("\n");
  const violationLines = violations
    .map((entry) => {
      const { owner, invariant, code, detail } = entry as Record<
        string,
        unknown
      >;
      return `- [${String(owner ?? "?")}] ${String(invariant ?? "?")} (${String(code ?? "?")}): ${String(detail ?? "").slice(0, 400)}`;
    })
    .join("\n");
  return {
    messages: [
      { role: "system", content: TASK_PROMPT },
      {
        role: "user",
        content:
          `skills catalog:\n${catalog || "(none)"}\n\n` +
          `invariant violations this session:\n${violationLines || "(none)"}\n\n` +
          `transcript digest:\n${digest}`,
      },
    ],
  };
}

/** Tolerant extraction: fences, chatter, garbage all resolve honestly. */
export function parseSelfReviewCandidates(text: string): unknown[] {
  return parseSelfReviewAnswer(text).candidates;
}

/**
 * The review's full answer: the three lanes, each tolerant on its own (a
 * lane the model omitted is an empty lane, never an error). The growth
 * lanes' elements are validated to the `growth.proposed` suggestion shape
 * — a malformed element is dropped rather than trusted.
 */
export function parseSelfReviewAnswer(text: string): {
  candidates: unknown[];
  deficiencies: SelfReviewProposal[];
  aspirations: SelfReviewProposal[];
} {
  try {
    const stripped = text.replace(/```(?:json)?/giu, "");
    const start = stripped.indexOf("{");
    const end = stripped.lastIndexOf("}");
    if (start < 0 || end <= start)
      return { candidates: [], deficiencies: [], aspirations: [] };
    const parsed = JSON.parse(stripped.slice(start, end + 1)) as {
      candidates?: unknown;
      deficiencies?: unknown;
      aspirations?: unknown;
    };
    const candidates = Array.isArray(parsed.candidates)
      ? parsed.candidates
      : Array.isArray(parsed)
        ? parsed
        : [];
    return {
      candidates,
      deficiencies: parseProposals(parsed.deficiencies),
      aspirations: parseProposals(parsed.aspirations),
    };
  } catch {
    return { candidates: [], deficiencies: [], aspirations: [] };
  }
}

const PROPOSAL_KINDS = new Set(["tool", "skill", "rule", "policy"]);

/** One lane of proposals: the shape the growth fact carries, or nothing. */
function parseProposals(value: unknown): SelfReviewProposal[] {
  if (!Array.isArray(value)) return [];
  const out: SelfReviewProposal[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const { kind, capability, reason } = entry as Record<string, unknown>;
    if (typeof kind !== "string" || !PROPOSAL_KINDS.has(kind)) continue;
    if (typeof capability !== "string" || !capability.trim()) continue;
    out.push({
      kind: kind as SelfReviewProposal["kind"],
      capability: capability.trim().slice(0, 200),
      reason: typeof reason === "string" ? reason.trim().slice(0, 500) : "",
    });
  }
  return out;
}

/**
 * One proposal: the SHAPE the `growth.proposed` fact's suggestions carry
 * (contracts/events.ts), declared here so the review's answer and the
 * journal fact cannot drift. `observations` is always 1 (one task's
 * retrospection); `sources` is the session that saw it.
 */
export type SelfReviewProposal = {
  kind: "tool" | "skill" | "rule" | "policy";
  capability: string;
  reason: string;
};

/** What one review would publish as one growth fact. */
export type SelfReviewGrowthFact = {
  suggestions: SelfReviewProposal[];
  considered: { tasks: number; gaps: number };
};

/**
 * The review's proposals as the growth fact's suggestions: both lanes,
 * deficiencies first (a deficiency is evidence; an aspiration is a wish —
 * the ordering is the priority), each with the retrospection's provenance.
 */
export function selfReviewGrowthFact(input: {
  deficiencies: readonly SelfReviewProposal[];
  aspirations: readonly SelfReviewProposal[];
  sessionID: string;
}): SelfReviewGrowthFact {
  const suggestions: SelfReviewProposal[] = [
    ...input.deficiencies,
    ...input.aspirations,
  ];
  return {
    suggestions,
    considered: { tasks: 1, gaps: suggestions.length },
  };
}

export type SelfReviewEvent =
  | Extract<RuntimeEvent, { type: "self_review.completed" }>
  | Extract<RuntimeEvent, { type: "self_review.skipped" }>;

export type SelfReviewDeps = {
  /** Config read — a THROWING read fails open to enabled + one warning (hermes). */
  enabled(): boolean;
  /** Captured before any await: the review must ride the turn's own runtime. */
  provider(sessionID: string): StreamingProvider | undefined;
  /**
   * The concurrency adapter (the wiring injects the live limiter —
   * title's options.stream pattern, one hop up so this module stays
   * limiter-free). Defaults to the provider's own stream.
   */
  runStream?: (
    provider: StreamingProvider,
    request: ProviderStreamRequest,
  ) => AsyncIterable<{ type: string; text?: string }>;
  events(sessionID: string): readonly RuntimeEvent[];
  /**
   * The write surface, ASYNC: plugin fibers activate lazily (a tool
   * dispatch spawns them; a text-only turn never touches them), so the
   * wiring's accessor ENSURES the skills fiber is mounted before the
   * review looks for it — a review about sedimenting skills must reach
   * its own write surface.
   */
  skills(): Promise<SkillService | undefined> | SkillService | undefined;
  publish(event: SelfReviewEvent): void;
  /**
   * The session's invariant violations (D1/D2's live facts), if the wiring
   * can name them. Optional: a wiring without it falls back to filtering
   * the event stream for `invariant.violation` — the review's evidence is
   * best-effort, never a requirement to run.
   */
  violations?(sessionID: string): readonly unknown[];
  /**
   * The growth lane's write surface: publishing ONE growth.proposed fact
   * (the proposals as suggestions). The whitelist's second target — a
   * proposal applies nothing by contract, so this is the review's only
   * power over the self-iteration loop: putting an observation on the
   * record where the proposal interface and the human read it.
   */
  publishGrowth?(input: {
    sessionID: string;
    fact: SelfReviewGrowthFact;
  }): void;
  /** True once the runtime is disposing — a late timer must vanish silently. */
  disposed?(): boolean;
};

export function createSelfReview(deps: SelfReviewDeps) {
  const tasks = new Map<
    string,
    { controller: AbortController; timer: ReturnType<typeof setTimeout> }
  >();

  async function completeOne(
    sessionID: string,
    controller: AbortController,
  ): Promise<void> {
    if (deps.disposed?.()) return; // a late fire after dispose: vanish, publish nothing
    const skip = (
      reason: Extract<
        SelfReviewEvent,
        { type: "self_review.skipped" }
      >["reason"],
    ) =>
      deps.publish({
        type: "self_review.skipped",
        at: new Date().toISOString(),
        sessionID: sessionID as never,
        reason,
      });
    // Discipline 3: provider FIRST — before the digest, before any await.
    const provider = deps.provider(sessionID);
    if (!provider) return skip("no_provider");
    const skillService = await deps.skills();
    if (!skillService) return skip("no_skills");
    const events = deps.events(sessionID);
    const digest = buildSelfReviewDigest(events);
    if (!digest) return skip("no_input");
    // The violations this session tripped (D1/D2's live facts): the
    // retrospection's hardest evidence. Without them the review can only
    // guess from the transcript; with them a structural violation is the
    // first thing it sees.
    const violations = deps.violations
      ? deps.violations(sessionID)
      : events.filter(
          (event) =>
            (event as { type?: string }).type === "invariant.violation",
        );
    const { messages } = buildSelfReviewPrompt(
      digest,
      skillService.list(),
      violations,
    );

    let output = "";
    try {
      const request: ProviderStreamRequest = {
        signal: controller.signal,
        messages,
      };
      const stream = deps.runStream
        ? deps.runStream(provider, request)
        : provider.stream(request);
      const iterator = stream[Symbol.asyncIterator]();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("self review timed out")),
          SELF_REVIEW_TIMEOUT_MS,
        );
      });
      try {
        const collect = async () => {
          while (true) {
            const next = await iterator.next();
            if (next.done) break;
            if (next.value.type === "content") output += next.value.text;
            if (output.length >= SELF_REVIEW_OUTPUT_LIMIT) break;
          }
        };
        await Promise.race([collect(), timedOut]);
      } finally {
        if (timer) clearTimeout(timer);
        void iterator.return?.().catch(() => undefined);
      }
    } catch (error) {
      if (controller.signal.aborted) return skip("superseded");
      void error;
      return skip("error");
    }
    if (controller.signal.aborted) return skip("superseded");

    const answer = parseSelfReviewAnswer(output);
    const skillsCreated: string[] = [];
    const skillsUpdated: string[] = [];
    let rejected = 0;
    for (const candidate of answer.candidates) {
      try {
        const result = await skillService.upsertSkill(candidate);
        (result.created ? skillsCreated : skillsUpdated).push(result.name);
      } catch {
        // The boundary rejected it (whitelist/validation) — counted, never fatal.
        rejected += 1;
      }
    }
    // The growth lanes: ONE fact per review, deficiencies first. An empty
    // pair is an honest empty — nothing is published for it (a journal
    // full of "I thought of nothing" is noise, not an audit trail).
    const fact = selfReviewGrowthFact({
      deficiencies: answer.deficiencies,
      aspirations: answer.aspirations,
      sessionID,
    });
    if (fact.suggestions.length > 0) deps.publishGrowth?.({ sessionID, fact });
    deps.publish({
      type: "self_review.completed",
      at: new Date().toISOString(),
      sessionID: sessionID as never,
      skillsCreated,
      skillsUpdated,
      rejected,
      proposals: fact.suggestions.length,
      deficiencies: answer.deficiencies.length,
      aspirations: answer.aspirations.length,
    });
  }

  function isEnabled(): boolean {
    try {
      return deps.enabled();
    } catch {
      console.warn(
        "[self-review] config read failed — leaving the review enabled (fail-open)",
      );
      return true;
    }
  }

  return {
    /** Fire after a turn; a second fire supersedes the first (live-turn wins). */
    schedule(sessionID: string) {
      // Disabled is SILENT: config is the documentation of that state,
      // and a per-turn "disabled" edge would flood the journal (the
      // "disabled" reason stays in the union for explicit calls.
      if (!isEnabled()) return;
      this.cancel(sessionID, "superseded");
      const controller = new AbortController();
      const timer = setTimeout(() => {
        tasks.delete(sessionID);
        void completeOne(sessionID, controller);
      }, SELF_REVIEW_DELAY_MS);
      tasks.set(sessionID, { controller, timer });
    },
    /** Live turns supersede an in-flight or pending review (hermes' fence). */
    cancel(_sessionID: string, _reason?: string) {
      const task = tasks.get(_sessionID);
      if (!task) return;
      clearTimeout(task.timer);
      task.controller.abort(
        new Error(`self review ${_reason ?? "superseded"}`),
      );
      tasks.delete(_sessionID);
    },
    /** The direct entry (tests + wiring that wants no timer). */
    review: completeOne,
    pendingCount: () => tasks.size,
  };
}
