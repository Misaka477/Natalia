---
name: edit-framework
description: How to change the framework itself through its two sanctioned paths — the gated generation switch and the isolated sandbox — without breaking a live runtime.
---

# Edit the framework

The framework can modify itself, and that is a feature, not an accident. It is
also the highest-risk thing it does, so every change goes through one of two
sanctioned paths. There is no third path: editing the live workspace directly
and reloading is not one.

## 1. Path A — a composition change (config, plugins, prompts)

Four tools, in this order:

1. **`propose_generation`** — builds a content-addressed candidate (config
   patch and/or plugin enable/disable list over the live composition) and
   journals `composition.proposed`. A non-empty `note` is required: the
   journal records WHY. Nothing runs. The answer tells you how many live
   sessions the change would affect.
2. **`apply_generation`** — drives the full orchestration. This call itself
   requires approval at the tool floor; composition changes confirm with the
   human by default. Without `now: true` the switch is durable but takes
   effect at the NEXT session — the default, and the one prompt-cache
   compatibility demands. A live session is never hot-swapped.
3. **`rollback_generation`** — always allowed, no gate and no approval. A
   candidate must never be able to block its own undo. The CURRENT generation
   is rolled back, never cancelled.
4. **`cancel_generation` / `list_generation_candidates`** — abandon a staged
   proposal (journaled as `composition.cancelled`) and read what is
   outstanding / applied / cancelled.

### The gate inside apply_generation

Four faces, all-must-pass, run in parallel with the verdict assembled from
every check (a face that throws is a FAILED check, never an exception — the
switch decision must always receive a verdict):

1. **constitution** — every active critical/high rule the user marked
   `forbidden` must still be carried by the candidate with the SAME statement
   and enforcement. A candidate may ADD policy; it may never subtract
   protection. Missing, reworded, or weakened rows each fail, by name.
2. **guards** — the architecture guard chain (`guard:imports` and friends) run
   against the candidate's repo root. No guard root above the workspace means
   the face fails loudly: an unverifiable candidate is not a passing one.
3. **smoke** — an isolated runtime boots with the candidate.
4. **nia** — the read-only audit surface returns its verdict.

Then, in order: approval → apply → health. The apply is a REPLACE, not a
merge: the generation holds the whole composition, so a field it does not
mention must be removed, not inherited. With `now: true` the runtime reloads,
`composition.switched` is journaled, and the post-switch health check runs;
a failed health check restores the previous config verbatim, takes it live,
journals the reversal, and records the incident. `stage` in the answer says
which of `gate-failed` / `approval-refused` / `apply-failed` / `deferred` /
`applied` / `rolled-back` you got.

## 2. Path B — a code change (the sandbox, T6)

For edits to source, tests, or build files:

1. **`sandbox_create`** — an isolated workspace candidate.
2. **`sandbox_write` / `sandbox_execute`** — make the change and run things
   inside the candidate. A sandboxed subagent additionally gets a READ-ONLY
   view of its own candidate's diff (`sandboxSelf`): no merge, no promote, no
   other candidate's id.
3. **`sandbox_diff`** — read the change before promoting it.
4. **Promote with validation** — the promote path runs your validation
   command INSIDE the candidate first, and an empty command is refused so a
   missing check cannot look like a green promote. The validation's own build
   output is cleaned out of the candidate before the merge: the gate tests
   the change, and the change stays what you made — validation passing must
   not merge its own artifacts into the host.
5. **`sandbox_merge`** — lands the change; **`sandbox_rollback`** undoes a
   promotion and reports honestly when there is no rollback point to restore.

### The L3 lane — changing `packages/**` (the core packages)

A code change to the core packages is a GENERATION with a `source` (a git ref
or a patch), not a sandbox promotion into the live tree. The routing is the
field's presence, and it is not negotiable:

- **a surface-only generation switches in-process** (the config reload of
  Path A);
- **a source-carrying generation drains first.** The live turns are waited
  out (a restart would drop them), the code lands (the ref is checked out or
  the patch applied in the workspace), and only then does the process
  underneath get replaced — the installer's probeVersion + swap + restart
  path. `apply_generation` with `now: true` runs exactly this; a caller that
  offers no such path gets `code-switch-unavailable`, which is a refusal, not
  a degrade to the reload. A reload over new code reports success while the
  old code keeps running — the one failure mode this lane exists to prevent.

After the restart the post-switch health check runs as always, and
`rollback_generation` remains the way back.

## 3. The three commands that never run

These are blocked BEFORE approval, so no skipped, cached, or auto-granted
approval can let them through (the self-protection patterns, C-TERM-001..003):

- killing the terminal multiplexer server process by name,
- deleting the Natalia runtime directory under the user's run dir,
- deleting the Natalia temporary directory.

If your change needs one of these, the change is wrong.

## 4. The code lane needs a source workspace

Both paths write into the workspace, so a change to packages/\*\* requires
the workspace to BE this project's repository. An installed deployment's
default workspace is the user's own project — the install ships no source —
and the runtime refuses a promotion that would write framework source into
such a workspace before anything lands. dev-environment is the
detection-and-setup path: it checks the workspace, the shipped bun's
version,
ode_modules, and disk space, and asks before installing
anything it finds missing.

## 5. Standing discipline

- The full test suite is green BEFORE you propose, not after. A candidate
  built on a red tree proves nothing.
- Never delete or weaken error handling to make a check pass.
- Signatures and the tool/registry surface are frozen: a change that renames
  or removes a public tool, event, or RPC member is a contract change and
  needs its own deliberate landing, not a ride-along.
- Every refusal is recorded. A rejected candidate's reason lands in the
  journal so a human can see what was attempted and why it was stopped.
- The human approves every switch and every promotion. There is no
  auto-merge, at any layer, forever.
