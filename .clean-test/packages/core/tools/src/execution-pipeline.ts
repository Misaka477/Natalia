/**
 * The reorderable tool-execution pipeline (档 C, step 1: machinery).
 *
 * The runtime's policy chain is currently a fixed handwritten order. This is
 * the pipeline shape that order should become: reorderable pre stages
 * (allow/deny/ask), a monotonic guard section (stages that can only deny — no
 * listener order can ever turn a denial back into an allow), the execute
 * wrapper, reorderable post stages (accept/replace/block), a single
 * finalizeContent application, and a frozen result no observer can rewrite.
 *
 * This module is deliberately runtime-agnostic: it composes stages and freezes
 * the outcome, and the runtime's own hooks are what the stages wrap. Wiring
 * `executeOneTool` onto it is the P10 step; the machinery is proven here.
 */
import type { ToolExecutionContext } from "./types";

/** A pre-execution decision. `deny` is final; `ask` halts for approval. */
export type PreToolDecision =
  | { decision: "allow" }
  | { decision: "deny"; reason: string }
  | { decision: "ask"; reason?: string };

/** A post-execution decision. `block` is final; `replace` swaps the content. */
export type PostToolDecision =
  | { decision: "accept" }
  | { decision: "replace"; content: string }
  | { decision: "block"; feedback: string };

/** A monotonic guard: returns a denial reason, or `undefined` to pass. */
export type ToolGuard = (input: ToolExecutionInput) => string | undefined;

export type ToolExecutionInput = {
  name: string;
  args: unknown;
  context: ToolExecutionContext;
};

/** The frozen outcome of a pipeline run. */
export type FrozenToolResult = Readonly<{
  /** The final content: executed, post-processed, finalized. */
  content: string;
  /** Lossless snapshot of the tool's raw output before finalization. */
  raw: string;
  /** Every pre-stage decision that ran, in order. */
  decisions: PreToolDecision[];
  /** The denial reason, when the run was stopped before execution. */
  denied?: string;
  /** The block feedback, when a post stage blocked the result. */
  blocked?: string;
}>;

export type PipelineRunResult =
  | { status: "allowed"; result: FrozenToolResult }
  | { status: "denied"; reason: string }
  | {
      status: "asking";
      decision: Extract<PreToolDecision, { decision: "ask" }>;
    }
  | { status: "blocked"; feedback: string };

/**
 * Composes the tool-execution stages in order and freezes the outcome.
 *
 * A stage registered later runs after the ones before it, so callers control
 * the order — the point of a waterfall. Guards are monotonic: once one denies,
 * the run stops and no later stage sees it, so no ordering of listeners can
 * turn a denial back into an allow.
 */
export class ToolExecutionPipeline {
  private pre: Array<
    (input: ToolExecutionInput) => PreToolDecision | Promise<PreToolDecision>
  > = [];
  private guards: Array<
    (
      input: ToolExecutionInput,
    ) => string | undefined | Promise<string | undefined>
  > = [];
  private executeFn:
    | ((input: ToolExecutionInput) => Promise<string>)
    | undefined;
  private post: Array<
    (
      input: ToolExecutionInput,
      content: string,
    ) => PostToolDecision | Promise<PostToolDecision>
  > = [];
  private finalizer: ((content: string) => string) | undefined;

  /** Appends a pre stage. */
  preStage(
    stage: (
      input: ToolExecutionInput,
    ) => PreToolDecision | Promise<PreToolDecision>,
  ): this {
    this.pre.push(stage);
    return this;
  }

  /** Appends a monotonic guard. */
  guard(
    stage: (
      input: ToolExecutionInput,
    ) => string | undefined | Promise<string | undefined>,
  ): this {
    this.guards.push(stage);
    return this;
  }

  /** Sets the execute wrapper (timeout/retry/metrics). Replaces any prior. */
  execute(fn: (input: ToolExecutionInput) => Promise<string>): this {
    this.executeFn = fn;
    return this;
  }

  /** Appends a post stage. */
  postStage(
    stage: (
      input: ToolExecutionInput,
      content: string,
    ) => PostToolDecision | Promise<PostToolDecision>,
  ): this {
    this.post.push(stage);
    return this;
  }

  /** Sets the final content invariant, applied exactly once. */
  finalize(fn: (content: string) => string): this {
    this.finalizer = fn;
    return this;
  }

  async run(input: ToolExecutionInput): Promise<PipelineRunResult> {
    const decisions: PreToolDecision[] = [];
    // Pre waterfall: the first deny or ask stops the run. Allows accumulate.
    for (const stage of this.pre) {
      const decision = await stage(input);
      decisions.push(decision);
      if (decision.decision === "deny")
        return { status: "denied", reason: decision.reason };
      if (decision.decision === "ask") return { status: "asking", decision };
    }
    // Monotonic guards: the first denial is final; a guard cannot force-allow.
    for (const guard of this.guards) {
      const reason = await guard(input);
      if (reason !== undefined)
        return {
          status: "denied",
          reason,
        };
    }
    if (!this.executeFn)
      // A decision-only pipeline: every pre stage allowed, and there is nothing
      // to execute. The caller that assembled only a decision chain reads the
      // status and ignores the (empty) content.
      return {
        status: "allowed",
        result: Object.freeze({ content: "", raw: "", decisions }),
      };
    const raw = await this.executeFn(input);
    let content = raw;
    // Post waterfall: the first block stops; a replace swaps the content.
    for (const stage of this.post) {
      const decision = await stage(input, content);
      if (decision.decision === "block")
        return { status: "blocked", feedback: decision.feedback };
      if (decision.decision === "replace") content = decision.content;
    }
    // The final content invariant runs exactly once.
    if (this.finalizer) content = this.finalizer(content);
    return {
      status: "allowed",
      result: Object.freeze({
        content,
        raw,
        decisions,
      }),
    };
  }
}
