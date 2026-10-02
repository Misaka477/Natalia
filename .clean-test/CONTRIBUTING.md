# Working on this repository

`npm run verify` is the definition of "this change is done". CI runs exactly
that, so a green local run and a green CI run mean the same thing.

```sh
bun install
npm run verify      # format → typecheck → test (incl. docs:check) → import guard
```

Everything below is the part `verify` cannot check. Each rule is here because it
was broken and something shipped that should not have; the incidents are given so
the rule can be judged rather than merely obeyed.

## Clean, tidy, no clutter left behind

Refactoring leaves orphans. Moving `sendMessage` from the controller to the
registry left a private steer-hook map in the controller that nothing read any
more; it was found by accident later. When you move a responsibility, grep for
what it left behind — the same session also left nine files that `prettier` would
have reformatted and a pair of redundant parentheses in a generated table.

**Nothing you touched should be less tidy than you found it.** If a change makes
something dead, delete it in the same commit.

## Commit often

Twenty-five rounds of work accumulated 129 changed files in one working tree
before anything was committed. That is not merely inconvenient: two files were
destroyed outright during that stretch by a tool mistake, and one was recoverable
only because it was new enough to be untracked — the other had to be rebuilt from
memory.

A large uncommitted tree is one accident away from being a total loss, and it
makes the history useless: fifteen unrelated concerns had to be reverse-engineered
out of one pile afterwards.

Commit each thing when it is done and verified, not when the session ends.

## Finished or not started — no stubs, no half-things

The same session produced roughly forty declarations that could never occur:

- `rollbackState: "available"` published in a completion record while no tool, RPC
  route or service method could invoke a rollback.
- `GoalRoundStop.max-tokens` declared, and unreachable because a length finish
  already throws and surfaces as `error`.
- `turn.finished.reason: "missing_final_response"` declared and never set by any
  producer.
- `SandboxStatus.merge_previewed` / `merged` / `conflicted`, none of which any
  code path could emit.

Three of these were removed and the rest were made reachable, but none should have
shipped. **A field, enum member, event type or capability that nothing produces is
worse than absent**: it tells every later reader that a path exists.

This is not a rule against deciding _not_ to build something. Declining to add a
generic job layer over two domains that already worked was the right call, and it
is recorded with its reasoning. The failure mode is a stub that exists without
saying so.

## Fix what you find, including what you did not write

A gate that fails on pre-existing breakage is not someone else's problem. The
gates in this repository were all red at once — a typecheck break, four import
guard violations, eighty-six unformatted files — and each was left alone on the
grounds that it predated the work in progress. The cost compounds:

- Nobody reads a gate that always fails, so it stops catching anything. The
  format gate's output had gone unread long enough that its count was a surprise.
- The same investigation gets done twice. The dead enum members were eventually
  examined properly, and they turned out to be deliberate vocabulary for a merge
  lifecycle rather than the removals they looked like — a conclusion that would
  have been reached sooner by looking than by deferring.

Fix it, or record it explicitly as debt with a reason. Leaving it silently is what
makes it grow.

## Verify with the repo's gate, over the whole tree

Not a subset you picked, and not a command you assembled.

A gate is only worth having if it is the one you actually run. Four separate
failures in one stretch of work came from checking a hand-chosen subset instead:
a typecheck break survived ten rounds because only the packages that had been
touched were compiled, an import guard had never been run at all, a format gate
reported 86 files for long enough that nobody read its output, and one package's
tests were never in the root `test` script — so they only ran when invoked by
hand, and were reported as passing.

The last one is worth dwelling on: **a test that is not in `npm test` does not
run.** If you add a package with tests, add it to the root `test` script.

The root script also sets `--max-concurrency=4`. Running the suite bare at full
concurrency produces a handful of timeouts that are load, not logic — they change
between runs, which makes them easy to wave away and easy to stop reading. Use
the script.

## Test enough, and watch each test fail

Write the assertion, then break the thing it is about, then confirm it goes red.

A test you have only ever seen pass tells you nothing: it may be exercising the
wrong path, asserting something trivially true, or checking a value that would
hold whether or not the code works. Two tests written here as proof of a fix
turned out to pass with the fix removed — one drove a code path that raised
before reaching the code under test, and one asserted on a branch no correct
implementation would take.

This is cheap. Delete the fix, run the one test, put the fix back.

## Assert the outcome, not the absence of failure

`expect(answer).not.toContain("refused")` cannot distinguish "the gate let this
through" from "something else refused it first" — it reads as proof the gate
works while proving nothing.

Assert the thing you actually mean: that the goal is `complete`, that the file is
gone, that the second promotion was refused _and the first candidate's work is
still there_. Negative assertions are the ones that pass for the wrong reason.

## A completion claim cites a gate, not a recollection

A checklist you wrote and updated cannot establish that the work is done — it is
your own answer key. One item here was recorded complete and was not: the
consumer of a field had a passing test, the field's contract was correct, and the
producer that was supposed to fill it did not exist, so the value was silently
absent for nineteen rounds of work.

**If a claim can be checked by a command, run the command and quote it.** Where a
contract declares a field, the test that proves it belongs on the _producer_ —
the code that writes the field — not only on the consumer that reads it.

## Related

- `docs/api-reference.md`, `docs/types-reference.md`, `docs/config-reference.md`
  are generated. `docs:check` (inside `npm test`) fails when they are stale, and
  tells you the command to regenerate them.
- `packages/tooling/testing/bin/contract-producer-guard.ts` fails when a contract
  event type or enum member has nothing that produces it. Wire it, remove it, or
  add it to that file's `ALLOWED` map with the reason it stays — the map is the
  record of the decision, and entries that stop being needed fail the check too.
- `packages/tooling/testing/bin/import-guard.ts` enforces the package boundary
  rules. When it flags a dependency, the fix is usually to add the package to the
  right allowlist only if the dependency is genuinely intended — it is there to
  make the boundary decision explicit, not to be silenced.
