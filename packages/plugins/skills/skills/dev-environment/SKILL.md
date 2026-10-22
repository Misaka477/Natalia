---
name: dev-environment
description: Use before changing this project's own code (packages/**, apps/**, scripts/**) or rebuilding it — the detection and setup path for the development environment. Also use when a build or test fails because a tool is missing or the wrong version.
---

# The development environment

Self-iteration needs three things, and only the first ships with the
product: the **source** (`<install>/source`), the **toolchains**
(`<install>/toolchains`), and a **workspace pointed at that source**. This
skill is how you find out which of the three you have, and what to ask for
when you do not.

## 0. Detect before you propose anything

Run these, in order, and STOP at the first failure:

1. **Is the workspace the source?** Look for `packages/`, `apps/`,
   `scripts/`, `bun.lock` and `package.json` at the workspace root. If they
   are not there, the workspace is somebody else's project and a code
   change would write into it. Say so, and ask the user to open a workspace
   at `<install>/source` (or to point you at their checkout).
2. **Is bun there, and is it the right one?** `<source>/../toolchains/bun/bun.exe
--version` must print **1.4.0**. The suite's green is a statement about
   ONE bun version; a rebuild that picks up whatever bun is on the PATH can
   be green on this machine and wrong everywhere else. Use the shipped
   binary for every command below, never a PATH bun.
3. **Is the tree installed?** `<source>/node_modules` must exist. If it does
   not, `bun install` against the shipped `bun.lock` (this repository has no
   `npm install`: the protocol is `workspace:*`).
4. **Is there room?** A rebuild needs the source copy plus roughly 300 MB
   of `node_modules` plus build output. Check free disk space and refuse
   with the number if it is under 1.5 GB.

## 1. What a change needs, and what it does not

Do not ask for a toolchain the change does not use. Match the change:

| You are changing                    | You need                                                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| a plugin, a skill, a prompt, config | bun only                                                                                                                 |
| `packages/**` TypeScript            | bun only                                                                                                                 |
| `packages/framework/diff-wasm`      | bun + cargo + the wasm target (the grammars are PREBUILT in `toolchains/grammars`, so no network and no crates.io fetch) |
| `apps/cef-desktop` (the C++ host)   | bun + cmake + a C++ toolchain                                                                                            |

## 2. Asking, not installing

Installing a toolchain is a system-level side effect, so it is the user's
decision, never yours:

- **Ask whether you may install**, and **ask where**. The default offer is
  `<install>/toolchains` (reversible, no administrator rights, and the
  uninstaller already removes `<install>`). A system-wide install is the
  user's call.
- **Never install silently, never retry an install, never fall back to a
  different version.** A build that "worked" with the wrong bun is a lie
  with a green checkmark.
- If the user declines, the candidate stays in the sandbox where it is
  recoverable. Say that, rather than leaving a half-applied change behind.

## 3. Building and verifying

- Use the shipped bun for every step: `<install>/toolchains/bun/bun.exe run
  <script>`.
- **Run tests with the `./` prefix** (`bun test ./packages/<name>/test`).
  The release tree carries a copy of the source, and bun's test filter is a
  substring match — a bare `bun test packages/...` matches that copy too and
  runs its tests, which fail for want of a node_modules beside them. The
  repository's own scripts and CI use the `./` form for exactly this reason.
- After a build, READ THE RESULT BACK. A command exiting 0 is not a
  verification: the artifact's version, its presence, and the suite's own
  output are.
- A test that fails is yours to fix, unless the repository records it as
  failing already. "Pre-existing" is not an answer without evidence.

## 4. The code lane's boundary

The generation lanes (`edits`, `tree`, `staged-build`) all write into the
WORKSPACE. For a change to this project's own code, the workspace must BE
the source — that is what step 0 checks, and it is not a formality: an
installed deployment's default workspace is the user's own project, and a
`packages/**` change aimed at it would write framework files into
somebody's repository.

The guards face (`guard:imports` and its neighbours) runs against the
candidate's repo root and needs `package.json` with a `guard:imports`
script above the workspace. No such root means the face fails loudly at the
switch, which is correct — and a reason to check step 0 first.
