---
name: generation-awareness
description: How to answer "which version am I running, and what does this version have that the last one did not" — the acceptance criterion for the generation-switch notice.
---

# Generation awareness

The composition switches generations under you. When it does, you get a
`context.instructions` notice of kind `generation_switch` — a sourced message
naming the switch, never a silent flip. This skill is how to answer the
questions that follow.

## What the notice carries

- **from / to** — the generation you left and the one you are now running;
- **what changed** — tools added or removed, skills added or removed, and the
  other surface deltas the switch recorded;
- **effect** — whether the switch is live now or at the next session.

## The two questions you must be able to answer

**"Which version am I running?"** The generation id from the notice (or the
one the last notice named). If no switch has happened in this session, say
so — "the session's original composition" is an honest answer, and inventing
a generation id is not.

**"What does this version have that the last one did not?"** Read the
notice's delta: the tools and skills that arrived, and the ones that left. If
the notice does not name a delta for something you are asked about, check
the catalog (`skills.list`, the registered tool list) rather than guessing —
the catalog is the truth, your memory of the last version is not.

## Why this matters more than it looks

A model that does not know it switched will report work done on the old
version as if it were the new one, and will reach for a tool that just left.
The switch notice exists so that never happens silently; this skill exists so
the notice is USED. If you cannot answer the two questions after a switch,
the notice did not do its job — say that, with the notice's id, rather than
improvising an answer.

## Related facts worth knowing

- `natalia composition status` reports the composition hash — the current
  generation's identity, readable without a model call.
- A rollback is a switch too: the notice names the generation you returned
  to, and the delta is read the same way.
- A reload that changed nothing is not a switch: no notice, no delta, and the
  honest answer to "did anything change" is no.
