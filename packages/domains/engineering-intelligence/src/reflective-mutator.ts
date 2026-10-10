import type {
  EvaluationCase,
  EvaluationResult,
  EvaluationSample,
} from "./evaluation";

/**
 * L4b's reflective mutator: one component per round, one reflection call,
 * a candidate that carries its own hypothesis.
 *
 * The shape is taken from the reference engine's source and corrected by
 * it:
 *
 * 1. **The reflection dataset is three fields, not the trajectory.**
 *    `{Inputs, Generated Outputs, Feedback}` — a trajectory原文 is noise
 *    the mutator cannot use; the feedback is what gives it direction.
 * 2. **One component per round.** A round that rewrites two things at once
 *    cannot say which change helped, so the proposer refuses anything but
 *    exactly one.
 * 3. **The proposer proposes; the engine accepts.** This module never
 *    decides that a candidate is better — it produces the candidate and
 *    the reflection that produced it. Acceptance and selection are the
 *    engine's sole authority (L3's strict-improvement rule, P4c's Pareto
 *    front).
 * 4. **The holdout never enters the dataset.** The builder reads the
 *    trainable bucket of the evaluation result and NOTHING else; the
 *    sealed bucket is structurally present on the same object and never
 *    read.
 *
 * The four hard constraints (anti parameter-tuning, anti overfitting,
 * mandatory prototype, mandatory self-criticism) ride the prompt as text:
 * a constraint enforced only by a later validator is a constraint that
 * loses to a deadline. The prompt also forbids delegation — constraints
 * get lost when they are summarized for a subagent.
 */

/**
 * The reflection template, verbatim from the reference engine's
 * `default_prompt_template`. The two placeholders are MANDATORY — the
 * validator refuses a template missing either, because a prompt rendered
 * without them is a prompt the model answers from nothing.
 */
export const DEFAULT_REFLECTION_TEMPLATE = `I provided an assistant with the following instructions to perform a task for me:
\`\`\`
<curr_param>
\`\`\`
The following are examples of different task inputs provided to the assistant along with the assistant's response for each of them, and some feedback on how the assistant's response could be better:
\`\`\`
<side_info>
\`\`\`
Your task is to write a new instruction for the assistant.

Read the inputs carefully and identify the input format and infer detailed task description about the task I wish to solve with the assistant.

Read all the assistant responses and the corresponding feedback. Identify all niche and domain specific factual information about the task and include it in the instruction, as a lot of it may not be available to the assistant in the future. The assistant may have utilized a generalizable strategy to solve the task, if so, include that in the instruction as well.

Provide the new instructions within \`\`\` blocks.`;

/** The two placeholders the validator enforces. */
export const REQUIRED_PLACEHOLDERS = ["<curr_param>", "<side_info>"] as const;

/**
 * A template missing either placeholder is refused. The reference engine
 * raises on the same condition; the failure it prevents is a reflection
 * call that renders a prompt with a hole in it and gets a confident answer
 * about nothing.
 */
export function validatePromptTemplate(template: string): void {
  for (const placeholder of REQUIRED_PLACEHOLDERS)
    if (!template.includes(placeholder))
      throw new Error(
        `reflection template is missing the required placeholder ${placeholder}`,
      );
}

/** Render the template with the current parameter and the side info. */
export function renderReflectionPrompt(input: {
  template?: string;
  /** The artifact's current text (the component being rewritten). */
  currentParam: string;
  /** The rendered reflection dataset. */
  sideInfo: string;
}): string {
  const template = input.template ?? DEFAULT_REFLECTION_TEMPLATE;
  validatePromptTemplate(template);
  return template
    .replaceAll("<curr_param>", input.currentParam)
    .replaceAll("<side_info>", input.sideInfo);
}

/** The reflection dataset's atom — three fields, nothing else. */
export type ReflectionEntry = {
  Inputs: string;
  "Generated Outputs": string;
  Feedback: string;
};

/**
 * How much of a tool/test output the feedback carries: the head and the
 * tail, each bounded. A full log is noise; the first 500 characters say
 * what ran and the last 500 say how it ended, which is where failures
 * live.
 */
export const FEEDBACK_HEAD_CHARS = 500;
export const FEEDBACK_TAIL_CHARS = 500;

export function boundedFeedback(text: string): string {
  if (text.length <= FEEDBACK_HEAD_CHARS + FEEDBACK_TAIL_CHARS) return text;
  const head = text.slice(0, FEEDBACK_HEAD_CHARS);
  const tail = text.slice(-FEEDBACK_TAIL_CHARS);
  return `${head}\n…(truncated ${text.length - head.length - tail.length} chars)…\n${tail}`;
}

/**
 * Build the reflection dataset from an evaluation result's TRAINABLE
 * bucket. The holdout bucket sits on the same object and is never read —
 * that is the whole design: the mutator's input is constructed without the
 * sealed material, so peeking is not a discipline question.
 */
export function buildReflectionDataset(input: {
  result: EvaluationResult;
  /** The visible pool, for the inputs and outputs the failures refer to. */
  pool: readonly EvaluationSample[];
}): ReflectionEntry[] {
  const byID = new Map(input.pool.map((sample) => [sample.id, sample]));
  return input.result.trainableFailureCases.map((failure) => {
    const sample = byID.get(failure.sampleID);
    return {
      Inputs: sample?.input ?? `(sample ${failure.sampleID} not in the pool)`,
      "Generated Outputs": sample?.output ?? "",
      Feedback: boundedFeedback(
        [failure.detail, sample?.feedback].filter(Boolean).join("\n"),
      ),
    };
  });
}

/** Render the dataset as the side-info block (the template's second slot). */
export function renderSideInfo(entries: readonly ReflectionEntry[]): string {
  return entries
    .map(
      (entry, index) =>
        `Example ${index + 1}:\nInputs: ${entry.Inputs}\nGenerated Outputs: ${entry["Generated Outputs"]}\nFeedback: ${entry.Feedback}`,
    )
    .join("\n\n");
}

/** The candidate's axis: sharpen what works, or try a different mechanism. */
export type CandidateAxis = "exploitation" | "exploration";

/**
 * A candidate carries a FALSIFIABLE hypothesis and its axis. A candidate
 * without them is not a candidate — it is a guess, and a guess cannot be
 * accepted or refused for a reason.
 */
export type ReflectiveCandidate = {
  /** The component this candidate rewrites (exactly one per round). */
  component: string;
  /** The candidate's new text for that component. */
  text: string;
  /** The claim this candidate would make true, stated so evaluation could disprove it. */
  hypothesis: string;
  axis: CandidateAxis;
};

export type CandidateParse =
  | { ok: true; candidate: ReflectiveCandidate }
  | { ok: false; reason: string };

/**
 * Parse the reflection call's answer into a candidate. The answer is the
 * new instruction inside ``` blocks plus a one-line metadata header the
 * prompt demands; a malformed answer is a refusal with a reason, never a
 * half-candidate.
 */
export function parseCandidate(
  answer: string,
  input: { component: string },
): CandidateParse {
  const fenced = /```(?:[a-z]*)\n?([\s\S]*?)```/u.exec(answer);
  const text = fenced?.[1]?.trim();
  if (!text) return { ok: false, reason: "no fenced candidate text" };
  const hypothesis = /^\s*hypothesis:\s*(.+)$/imu.exec(answer)?.[1]?.trim();
  const axisRaw = /^\s*axis:\s*(exploitation|exploration)\s*$/imu.exec(
    answer,
  )?.[1];
  if (!hypothesis)
    return { ok: false, reason: "candidate carries no falsifiable hypothesis" };
  if (!axisRaw)
    return {
      ok: false,
      reason: "candidate carries no axis (exploitation|exploration)",
    };
  return {
    ok: true,
    candidate: {
      component: input.component,
      text,
      hypothesis,
      axis: axisRaw as CandidateAxis,
    },
  };
}

/** One reflection call: the prompt in, the candidate (or a refusal) out. */
export type ReflectionSampler = (input: {
  prompt: string;
  component: string;
}) => Promise<string>;

/**
 * Propose one reflective candidate for ONE component.
 *
 * The round structure is the reference engine's: the proposer produces
 * and the engine accepts. This function stops at the proposal — the
 * candidate comes back with its prompt (the audit trail of what the
 * mutator was told) and the engine decides.
 */
export async function proposeReflective(input: {
  /** Exactly one component per round — the rule that makes attribution possible. */
  components: readonly string[];
  /** The component's current text (the `<curr_param>` slot). */
  currentParam: string;
  /** The evaluation result whose TRAINABLE bucket feeds the dataset. */
  result: EvaluationResult;
  /** The visible pool the failures refer to. */
  pool: readonly EvaluationSample[];
  sampler: ReflectionSampler;
  template?: string;
}): Promise<
  | {
      ok: true;
      candidate: ReflectiveCandidate;
      prompt: string;
      dataset: ReflectionEntry[];
    }
  | { ok: false; reason: string }
> {
  if (input.components.length !== 1)
    return {
      ok: false,
      reason: `one component per round, got ${input.components.length}`,
    };
  const component = input.components[0]!;
  const dataset = buildReflectionDataset({
    result: input.result,
    pool: input.pool,
  });
  if (!dataset.length)
    return {
      ok: false,
      reason: "no trainable failure cases — nothing to reflect on",
    };
  // The constraints RIDE the prompt — a constraint enforced only by a
  // later validator loses to a deadline. The no-delegation rule is here
  // too: constraints get lost when they are summarized for a subagent, so
  // the mutator does the work itself.
  const prompt = [
    "You are optimizing ONE component of an artifact. Obey these constraints:",
    ...MUTATOR_CONSTRAINTS.map((rule) => `- ${rule}`),
    `- ${MUTATOR_NO_FANOUT}`,
    "",
    "Answer with the new component inside ``` blocks, then two lines:",
    "hypothesis: <the falsifiable claim this candidate would make true>",
    "axis: <exploitation|exploration>",
    "",
    renderReflectionPrompt({
      ...(input.template ? { template: input.template } : {}),
      currentParam: input.currentParam,
      sideInfo: renderSideInfo(dataset),
    }),
  ].join("\n");
  const answer = await input.sampler({ prompt, component });
  const parsed = parseCandidate(answer, { component });
  if (!parsed.ok) return parsed;
  return { ok: true, candidate: parsed.candidate, prompt, dataset };
}

/**
 * The four hard constraints, as the prompt text that carries them. Kept
 * here so a test can assert the prompt the mutator sends actually contains
 * them — a constraint that exists only in a design document constrains
 * nobody.
 */
export const MUTATOR_CONSTRAINTS = [
  "anti-parameter-tuning: a candidate that differs only in constants is a parameter variant; change a mechanism",
  "anti-overfitting: never hardcode knowledge about specific inputs you have seen; never echo example identifiers",
  "mandatory-prototype: validate the core idea in isolation before writing the final candidate",
  "mandatory-self-criticism: after writing, re-read it — if only constants differ, rewrite",
] as const;

/** The no-delegation rule (constraints get lost when summarized for a subagent). */
export const MUTATOR_NO_FANOUT =
  "Do all work in the main session — do NOT delegate to subagents. Constraints get lost when you delegate.";
