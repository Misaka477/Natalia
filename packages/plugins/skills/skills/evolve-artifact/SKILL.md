---
name: evolve-artifact
description: How to run one complete self-iteration — reflect or agree on a plan, change the artifact in the sandbox, run the tests, get the human's approval, hot-update. No falsifiable candidates, no evaluation rounds, no gates.
---

# Evolve an artifact

Self-iteration here is a LOOP with ONE shape, entered from TWO sides:

```
   触发（两条路）
     ├─ 自主：你干完活 → 反思（该改什么）
     └─ 用户：聊天 → 方案定好
            ↓
    开始迭代 ← skills / mcp / acp / 代码 都在这里面改
            ↓
    测试审核（跑一下，过不过）
            ↓
    用户批准（拍板）
            ↓
    热更新到新版本（可回滚）
```

Depends on the `write-tool` skill (how a new capability is shaped and made
reachable), the `edit-framework` skill (how a framework change is landed,
including the L3 code lane), and the `sandbox-discipline` skill (where the
change happens and what the modes mean). Read all three first.

## 1. Enter — the two doors

**Door A, reflection.** After real work, ask the three questions the
background review already asks: what knowledge is worth a skill, what went
wrong that a rule or policy should have prevented, what capability did you
reach for that did not exist. The journal is the raw material, not memory.
A wish that names a disabled plugin in the catalog is already routed for
you — the bridge stages the candidate from your own words.

**Door B, the user's plan.** The human says what is wrong and what should
happen ("X 不好用，改改"). The plan is the trigger; nothing else is needed.

Both doors end at the same place: a concrete change to make.

## 2. Iterate — change the artifact in the sandbox

The change happens in a SANDBOX, never in the live workspace: a git
repository gets a real worktree branch, everything else gets a snapshot
candidate. Skills, MCP servers, ACP adapters, and code (`packages/**`) are
all in scope — see `edit-framework` for the code lane's drain-and-restart
rule and `sandbox-discipline` for the modes.

There is no candidate format to fill in, no hypothesis to state, no axis to
pick. The change is the change: make it, look at it, and be able to say in
one sentence what it does and why.

## 3. Test — run the suite, read the result

Run the tests. The answer is two numbers and one sentence: did it pass, and
what did it cost. There is no evaluation set, no holdout split, no scoring
function — a test either passes or it does not, and a change that cannot be
tested is not ready to propose.

## 4. Approve — the human decides

The proposal reaches the human through the chat (`ask_user`) or the
generation tool's approval floor. The human's decision is the only
authorization: growth never self-authorizes. A refusal is recorded with its
reason and the change stays in the sandbox — recoverable, never gone.

## 5. Hot-update — land it, keep the way back

An approved change lands through `apply_generation`: the four-face
verification gate runs, then the switch. A surface-only change (config,
plugins, prompts, policy rows) takes effect in-process; a code change
(`packages/**`) drains the live turns, lands the code, and restarts — see
`edit-framework`. Every switch records the generation it left, so
`rollback_generation` can always take it back.

## What this loop never does

- never auto-merges: the human approves every landing;
- never lands untested change: the suite runs before the proposal;
- never deletes on its own: removals archive, and the archive is
  recoverable;
- never lets a refusal disappear: every refusal is named and journaled.
