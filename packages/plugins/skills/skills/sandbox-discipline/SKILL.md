---
name: sandbox-discipline
description: The sandbox modes, which write paths are confined, and how to ask for a one-time widening — the behavior side of the confinement promise.
---

# Sandbox discipline

Every write the model makes answers to one mode. The modes are the whole
vocabulary of "where may this land"; knowing them is the difference between
a refused call you can act on and a confused retry loop.

## The four rungs

```
1  read only        任何写都拒
2  ask              任何写都问（默认）
3  workspace write  工作区内自动；域外拒，可申请一次性放宽
4  full             哪都能写，不问（完全绕过禁闭）
```

- **browser and computer use are NOT in this vocabulary.** They act on the
  world outside the workspace (pages, remote services, the screen), and
  confining them would confine away their purpose. Their results are outside
  the confinement promise, deliberately.
- The effective rung for a call is reported to you (the runtime context names
  it). A rung change arrives as a sourced message, never a silent flip: you
  always know how much authority you currently have.

## What is confined

- **`fs_write` / `fs_edit`** — the path is judged by the policy's containment
  (canonicalize-then-contain: realpath first, then compare), so `..`, an
  absolute path outside the root, and a symlink that spells inside but points
  outside are all refused.
- **shell commands (`sandbox_execute`, `run_shell`)** — the same mode, at the
  kernel's height: the spawn itself is wrapped, so redirections and heredocs
  inherit the confinement. "fs cannot write it but the shell can" is not a
  state that exists.
- **interactive terminals** — the pane's spawn is confined like any other, so
  typing into a live pane cannot escape the writable set either.
- **a sandboxed subagent's writes** — its worktree root plus its ownership
  domain; a write outside the domain is refused by name.

## When a write is refused

The refusal names the mode that refused it. That is the whole answer: the
policy denied it, not the world. Do not rephrase and retry — the judgement is
on the path, not the wording.

## Asking for more

A write refused by the mode can be retried ONCE with the escalation fields:

- `sandbox_permissions` — the wider mode you are asking for;
- `justification` — one sentence on why this call needs it.

The same approval the tool floor already uses resolves it. A grant is
per-call: the next call is back at the session's rung, and the grant itself
is a journaled fact. Asking is cheap and honest; quietly routing around the
refusal is neither.
