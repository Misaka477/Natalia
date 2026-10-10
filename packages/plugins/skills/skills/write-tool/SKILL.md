---
name: write-tool
description: How to add a new tool or tool plugin to this framework so the model can actually call it.
---

# Write a tool

A tool is the only way the model touches the world. A tool that is registered
but unreachable is worse than no tool: the model is told it exists, calls it,
and gets a refusal. This skill is the shape a new tool must have and the four
places its name must land.

## 1. The tool object

A tool is a plain object (`RuntimeTool`), not a class:

```ts
const tool: RuntimeTool = {
  name: "family_action", // snake_case; the model types this verbatim
  description: "One or two sentences: what it does and WHEN to use it.",
  requiresApproval: true, // see the approval rule below
  timeoutSec: 30, // optional default; maxTimeoutSec caps a per-call extension
  parameters: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
    additionalProperties: false, // always false: an unknown key is a model error, not a passthrough
  },
  output: genericToolCard({
    family: "family",
    callSummary: "read",
    resultSummary: "read",
  }),
  async execute(input, context) {
    // input is unknown: validate the shape yourself, then throw with a message
    // that says which argument was wrong. execute returns the model-facing string.
  },
};
```

Rules that are enforced, not style:

- `execute` returns a string. A tool whose result is JSON sets
  `output.schema` and `structured: true`; a content-returning tool (file bytes,
  command output) must NOT, or every read fails schema validation.
- `parameters.additionalProperties` is `false`. The provider rejects a call
  with an undeclared key, so a permissive schema buys nothing.
- The description is the tool's only advertisement. Name the action and the
  situation ("Use it after implementing a step so the work has evidence"), not
  the implementation.
- Approval rule of thumb: anything that writes, executes, or sends is
  `requiresApproval: true`; pure reads are `false`. The catalogue test pins
  your choice, so make it deliberately.
- Presentation is optional but expected: `output.presentCall` /
  `presentResult` / `presentationMeta` project the call and result into a card.
  A structured presenter reads `meta` (the facts computed once over
  (args, value)) instead of re-parsing the result string.

## 2. Where a tool is registered

Two paths, never both:

- **A plugin** (`natalia.plugin.json` + `src/index.ts`): register inside
  `setup` with `api.tools.register(tool)`. The plugin's `integrationPoints`
  must include `tools`. A plugin's tools are owned by the plugin: unloading
  the plugin releases them.
- **A built-in family** (framework code): contribute through a capability
  owner, then move what the kernel accepted into the registry the executor
  reads:

```ts
const owner = registry.registerOwner({
  id: "natalia-family",
  grants: ["services", "tools"] /* ... */,
});
owner.contribute("tools", tool.name, tool);
if (ctx.state.tools.get(tool.name))
  throw new Error(`framework tool already registered: ${tool.name}`);
ctx.state.tools.set(tool.name, tool);
```

The duplicate throw is deliberate: two tools of one name is a silent shadow,
and the provider refuses a tool list with duplicate names outright.

## 3. The reachability rule (the part everyone forgets)

A registered tool is not yet a callable tool. Its name must land in every
place that answers "what can the model call":

1. **The registry** — `api.tools.register` or the owner contribution above.
2. **The advertised list** — `runtimeToolNames()` in the host's
   tool-family capabilities module: the canonical names the real registry
   accepts, plus aliases. A name that exists but is not advertised is
   guidance pointing at something the model cannot call.
3. **The pinned catalogue test** — `[name, requiresApproval, timeoutSec?]`
   per tool. Adding a tool fails that test on purpose: it forces the approval
   boundary to be written down instead of absorbed.
4. **If the tool also exposes an RPC member** (a client-facing method, not
   just an in-turn tool), all of these move together, and the compiler
   enforces it: the contracts type, a row in the refusal-semantics table
   (`value` / `error` / `none`, with a reason), the capability group, and the
   route table. A member with no refusal row fails typecheck.

## 4. Pushing a tool into a child run

A subagent runner that pushes its own tools into a child's visible set must
DISPLACE the host tool of the same name, not sit beside it: the provider
refuses a list with two entries of one name, so a pushed `sandbox_diff` that
does not replace the host's `sandbox_diff` kills every sandboxed child on its
first step. Push through the same-name displacement helper, never append.

## 5. Before you call it done

- The tool has its own test: the happy path, the argument-validation refusals,
  and the boundary it refuses (permission, confinement, unknown id).
- The catalogue pin is updated with the approval boundary you chose.
- `bun run format`, `bun run typecheck`, and the guard suite pass.
- If the tool runs a child process, it honors the call's `timeoutSec` and
  `signal` so the two timers cannot drift.
