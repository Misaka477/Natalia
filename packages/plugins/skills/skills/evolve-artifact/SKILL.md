---
name: evolve-artifact
description: How to run one complete self-iteration — observe, propose a falsifiable candidate, evaluate, gate, and land it with the refusal recorded.
---

# Evolve an artifact

Self-iteration here is a LOOP, not a single question. "Ask once, write one
skill" is the thing this replaces. One iteration has six steps; skipping the
evaluation and gate steps is how a framework rots.

Depends on the `write-tool` skill (how a new capability is shaped and made
reachable) and the `edit-framework` skill (how a framework change is gated
and landed). Read both first.

## 1. Observe

The raw material is the session journal, not memory. The background review
loop already does the bounded version of this after each turn: a digest of
human turns, assistant replies, and tool names (capped), plus any invariant
violations the session tripped, asked three questions:

- **Sediment** — what knowledge from this work is worth a skill next time?
- **Deficient** — what went wrong that a rule, policy, or skill should have
  prevented? A violation fact is the strongest evidence; a failure or a redo
  is next.
- **Missing** — what capability did you reach for that did not exist?

The answer is JSON only. Failures are honest edges with a reason, never
silent. The deficiencies and aspirations lanes are recorded as FACTS
(`growth.proposed`): recording one applies nothing — growth never
self-authorizes, so a human decides what becomes work.

## 2. Propose — a candidate, not a wish

Every candidate carries, beside its content:

- **a falsifiable hypothesis** — the specific claim this candidate would make
  true, stated so an evaluation could prove it false. "Improve the release
  skill" is not a hypothesis. "Adding the rollback step to the release skill
  prevents the forgotten-verify failure seen twice this week" is.
- **an axis** — `exploitation` (sharpen what works) or `exploration` (try a
  different mechanism). Say which; a loop that only exploits converges to a
  local optimum and stops improving.

The mutator's four hard constraints:

1. **Anti parameter-tuning.** A candidate that differs from its parent only
   in constants, thresholds, or length caps is a parameter variant, and
   parameter variants almost always regress or tie. A good candidate changes
   a mechanism: a different structure, a different organization of the same
   rules, a different control flow. If only constants differ, rewrite.
2. **Anti overfitting.** Never hardcode knowledge about specific inputs you
   have seen, and never echo an example's identifier into the artifact.
   General rules ("validate the parse before submitting") are fine; memorized
   specifics are not.
3. **Prototype first.** Validate the core idea in isolation before writing
   the final candidate — try two or three variants, keep the one that works,
   delete the scratch work.
4. **Self-criticize.** After writing, re-read it: is this a genuinely new
   mechanism or a parameter variant? If the latter, rewrite.

And one process constraint: **the mutator does not fan out.** Delegating
candidate generation loses these constraints in transit — every subagent
hears a summary, not the rules. Do the work in the main session.

## 3. Evaluate — on data the candidate has not been optimized against

Score the candidate on the evaluation set, and keep the splits honest:

- The training split is what optimization may see.
- The holdout split is what the final gate uses, and it is INVISIBLE to the
  mutator by construction — not by promise. The material handed to a
  reflection step is `{inputs, generated outputs, feedback}` for training
  examples only; the holdout's failure cases still count toward the score but
  are never shown as reflection material.
- Variants produced in the same round are invisible to that round's mutator,
  so a candidate cannot breed with its own siblings.
- A score orders candidates; natural-language feedback gives them DIRECTION.
  A loop with scores and no feedback is a random walk.

Acceptance is strict improvement by default: a candidate lands only when its
total on the evaluation split is strictly greater than its parent's. Ties are
rejections unless a round explicitly opts into equal-moves exploration.

## 4. Gate — the necessity gate first, then the boundary

Before anything is written, the candidate faces the necessity gate:

- a create must use a NEW name (an update must say `kind: "update"` — the
  catalog is checked, not trusted);
- it must not restate an existing skill: token overlap of name+description
  against any catalog entry at or above 0.6 is refused;
- the body must be at least 200 characters and carry a markdown heading.

Then the validated write boundary, which is the ONLY autonomous write path:

- the action whitelist is create-or-update a skill by name — delete,
  execute, and file paths are not representable;
- the frontmatter is rebuilt by the boundary, never pasted through, so a
  proposal cannot smuggle a different name past validation;
- content is capped (64KB) and the name must match the kebab-case pattern;
- the write lands under the PROJECT skills root only. A skill that ships with
  a plugin is not rewritable by self-review: official skills are distributed
  by code and protected by the gate; self-sedimented skills live beside them,
  and the two never mix.

## 5. Land — with the refusals reported

A candidate that passes is written and the registry reloads so it is
immediately visible. A candidate that fails is COUNTED and its reason
recorded: `name: reason` rides the completion event, so a human can see what
the loop wanted to change and why it was stopped. The search history is not
thrown away — the refusals are how a reviewer learns where the traps are.

For a framework change rather than a skill, the landing is Path A or Path B
of the `edit-framework` skill: the gated generation switch or the sandbox
promotion, with the human's approval as the floor. Validation evidence is
recorded through `record_validation` (a real command, run and captured, with
the classes it satisfies) and cited by `record_completion` — claims without
evidence are not completions.

## 6. What this loop never does

- never auto-merges: the human approves every landing;
- never hot-swaps a live session: changes take effect at the next session
  boundary;
- never reads the holdout to choose a candidate;
- never lets a failed candidate disappear silently: every refusal is named.
