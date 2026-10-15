import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMPOSITION_PROFILE_SCHEMA,
  type CompositionProfile,
} from "@anthelia/composition";
import { effectiveConfinementMode } from "../src/runtime/tool-execution/execute-context";

/**
 * The composition-default file-effect mode (P3 base profile): the
 * `anthelia.sandbox` row wins, the legacy config key is its fallback
 * (retire the row with `disabled: true` to hand the key back), the
 * schema default closes the chain — and a hand-built profile cannot
 * smuggle an illegal mode past the membership guard.
 */

const profile = (rows: CompositionProfile["rows"]): CompositionProfile => ({
  schema: COMPOSITION_PROFILE_SCHEMA,
  rows,
  hash: "test-hash", // the consumer reads rows; the loader owns derivation
});
const row = (config: Record<string, unknown>, disabled?: boolean) => ({
  id: "anthelia.sandbox",
  ...(disabled === undefined ? {} : { disabled }),
  config,
  origin: { layer: "base" as const, file: "/app/composition.base.json" },
});

// The chain tests below name `os: "linux"` on purpose: they are about
// the REQUEST precedence (row, then legacy key, then schema default),
// and the platform gate that closes the chain is the subject of the two
// tests after them. Without the explicit os the question becomes "what
// can THIS host enforce", which on a rung-less host (Windows) answers
// danger-full-access for every mode — correct behaviour, wrong subject.
test("the composition row wins over the legacy config key", () => {
  expect(
    effectiveConfinementMode({
      profile: profile([row({ mode: "read-only" })]),
      configMode: "danger-full-access",
      os: "linux",
    }),
  ).toBe("read-only");
});

test("a retired row (disabled) hands the key back to legacy config", () => {
  expect(
    effectiveConfinementMode({
      profile: profile([row({ mode: "read-only" }, true)]),
      configMode: "danger-full-access",
      os: "linux",
    }),
  ).toBe("danger-full-access");
});

test("no profile: the legacy config key, then the schema default", () => {
  expect(
    effectiveConfinementMode({ configMode: "read-only", os: "linux" }),
  ).toBe("read-only");
  expect(effectiveConfinementMode({ os: "linux" })).toBe("workspace-write");
  expect(effectiveConfinementMode({ os: "linux" })).toBe("workspace-write");
});

test("membership guard: garbage in either source falls through to the chain's next legal value", () => {
  expect(
    effectiveConfinementMode({
      profile: profile([row({ mode: "sideways" })]),
      configMode: "also-bad",
      os: "linux",
    }),
  ).toBe("workspace-write");
  expect(
    effectiveConfinementMode({
      profile: profile([row({ mode: "sideways" })]),
      configMode: "read-only",
      os: "linux",
    }),
  ).toBe("read-only");
  expect(
    effectiveConfinementMode({
      profile: profile([row({})]),
      configMode: undefined,
      os: "linux",
    }),
  ).toBe("workspace-write");
});

/**
 * The platform gate, and why it lives at the END of the chain.
 *
 * The three sources above name a mode the host REQUESTS. A host whose
 * confinement rung was never built cannot enforce any of them, so the mode an
 * execution runs under and the mode the snapshot's danger indicator shows must
 * both be the degraded one. Gating the resolved answer — rather than each call
 * site — is what keeps those two readers from disagreeing.
 *
 * Measured, not theorised: with this gate absent, the base profile's
 * `workspace-write` reached `spawnSpec` on a rung-less host, `wrapConfinedCommand`
 * returned nothing, and the shell tool threw the information-free "the command
 * could not be started" for EVERY command. A `bun build --compile`d copy of the
 * shell tool reproduces it on Linux too — the compiled module's `import.meta.dir`
 * is Bun's embedded filesystem, where no on-disk backend can live.
 */
test("a host with no confinement rung runs danger-full-access, whatever the config asks for", () => {
  for (const os of ["win32", "darwin"] as NodeJS.Platform[]) {
    // The chain itself is unchanged: the row still wins, the config key still
    // falls back, the schema default still closes it. Only the last step asks
    // whether this host can enforce the answer.
    expect(
      effectiveConfinementMode({
        profile: profile([row({ mode: "read-only" })]),
        os,
      }),
    ).toBe("danger-full-access");
    expect(
      effectiveConfinementMode({
        profile: profile([row({ mode: "read-only" })]),
        configMode: "workspace-write",
        os,
      }),
    ).toBe("danger-full-access");
    expect(
      effectiveConfinementMode({ configMode: "danger-full-access", os }),
    ).toBe("danger-full-access");
    // And the schema default, which is what an out-of-the-box install ships.
    expect(effectiveConfinementMode({ os })).toBe("danger-full-access");
  }
});

test("on a rung-bearing host the gate is invisible", () => {
  // Linux keeps the sandbox it asked for; anything else would silently unconfine
  // every confined run on the one platform that can enforce them.
  expect(
    effectiveConfinementMode({
      profile: profile([row({ mode: "read-only" })]),
      os: "linux",
    }),
  ).toBe("read-only");
  expect(effectiveConfinementMode({ os: "linux" })).toBe("workspace-write");
  // And with no `os` the question is about THIS host, which is how the three
  // production call sites (execute-context, snapshot, turn-runner) ask it.
  expect(effectiveConfinementMode({})).toBe(
    process.platform === "linux" ? "workspace-write" : "danger-full-access",
  );
});

test("an approved escalation journals the entry; a refusal and a missing seam do not", async () => {
  // Sandbox study §6b①: entering a wider mode is ONE journal fact — the
  // audit trail and the danger indicator read it, never a second state.
  const { buildToolExecutionContext } = await import(
    "../src/runtime/tool-execution/execute-context"
  );
  const published: Array<Record<string, unknown>> = [];
  const build = (input: {
    refusal?: string;
    interactive?: boolean;
    configMode?: "read-only" | "workspace-write" | "danger-full-access";
  }) => {
    const ctx = {
      state: { serviceDirectory: { getOptional: () => undefined } },
      ports: {
        getTsRuntimeConfig: () => ({
          confinement: { mode: input.configMode },
          runtime: {},
        }),
        getInteractive: () =>
          input.interactive === false
            ? undefined
            : {
                requireApproval: async () => input.refusal,
              },
        // The remaining ports the context build touches: stubbed no-ops —
        // this test owns the approver, not the rest of the surface.
        getCapabilityRegistry: () => ({ service: () => undefined }),
        authorizeWorkspaceRead: async () => undefined,
        authorizeSandboxMerge: async () => undefined,
        toolSettings: () => ({}),
        scheduleRuntimeStatusSnapshot: () => undefined,
      },
    } as never;
    return buildToolExecutionContext({
      ctx,
      exec: { session: { id: "ses_escalation" } } as never,
      publish: (event) =>
        published.push(event as unknown as Record<string, unknown>),
      toolID: "run_shell",
      tool: { name: "run_shell" } as never,
      call: { id: "call_1" } as never,
      turnID: "turn_1",
      sessionID: "ses_escalation" as never,
      workspaceRoot: "/tmp",
      signal: new AbortController().signal,
      parsed: {},
    });
  };

  // Approved: the fact names the from/to pair and the justification.
  //
  // The FROM mode is the deployment default as this host can enforce it:
  // workspace-write where the rung exists, the degraded
  // danger-full-access where it does not (Windows) — the same gate the
  // chain tests above spell out, read through the production call site.
  const from =
    process.platform === "linux" ? "workspace-write" : "danger-full-access";
  const allowed = build({});
  const outcome = await allowed.sandboxApprover.request({
    requestedMode: "danger-full-access",
    justification: "the user asked for a host-wide install",
  });
  expect(outcome).toBe("allowed-once");
  expect(published).toEqual([
    {
      type: "confinement.escalated",
      at: expect.any(String),
      from,
      to: "danger-full-access",
      justification: "the user asked for a host-wide install",
      toolID: "run_shell",
      sessionID: "ses_escalation",
    },
  ]);

  // Refused: no fact — a refusal is not an entry.
  published.length = 0;
  const refused = build({ refusal: "read_only" });
  expect(
    await refused.sandboxApprover.request({
      requestedMode: "danger-full-access",
      justification: "nope",
    }),
  ).toBe("rejected");
  expect(published).toEqual([]);

  // No interactive seam: unavailable, and again no fact.
  const missing = build({ interactive: false });
  expect(
    await missing.sandboxApprover.request({
      requestedMode: "danger-full-access",
      justification: "nope",
    }),
  ).toBe("unavailable");
  expect(published).toEqual([]);
});

/**
 * 洞 2's four-rung ladder, wired: the session's rung override (the human
 * widening the sandbox mid-session) is what the tool context resolves, and
 * the escalation's approval id carries the rung it asked for so the
 * response's grant can be applied.
 */
test("the session's rung override is the mode the tool context resolves", async () => {
  const { buildToolExecutionContext } = await import(
    "../src/runtime/tool-execution/execute-context"
  );
  const approvals: string[] = [];
  const build = (input: {
    sessionMode?: "read-only" | "workspace-write" | "danger-full-access";
    configMode?: "read-only" | "workspace-write" | "danger-full-access";
  }) => {
    const ctx = {
      state: { serviceDirectory: { getOptional: () => undefined } },
      ports: {
        getTsRuntimeConfig: () => ({
          confinement: { mode: input.configMode },
          runtime: {},
        }),
        getInteractive: () => ({
          requireApproval: async (id: string) => {
            approvals.push(id);
            return undefined;
          },
        }),
        getCapabilityRegistry: () => ({ service: () => undefined }),
        authorizeWorkspaceRead: async () => undefined,
        authorizeSandboxMerge: async () => undefined,
        toolSettings: () => ({}),
        scheduleRuntimeStatusSnapshot: () => undefined,
      },
    } as never;
    return buildToolExecutionContext({
      ctx,
      exec: {
        session: { id: "ses_rung" },
        ...(input.sessionMode
          ? { sandboxModeOverride: input.sessionMode }
          : {}),
      } as never,
      publish: () => undefined,
      toolID: "run_shell",
      tool: { name: "run_shell" } as never,
      call: { id: "call_1" } as never,
      turnID: "turn_1",
      sessionID: "ses_rung" as never,
      workspaceRoot: "/tmp",
      signal: new AbortController().signal,
      parsed: {},
    });
  };

  // The deployment asks read-only; the session's rung says otherwise. The
  // session override wins — that is the whole point of the human's switch.
  // (danger-full-access is enforceable everywhere, so this line holds on
  // every host.)
  const widened = build({
    configMode: "read-only",
    sessionMode: "danger-full-access",
  });
  expect(widened.confinement).toBe("danger-full-access");
  // Without an override, the deployment default stands — as this host can
  // enforce it, which is the rung-less degradation on Windows.
  const deployment =
    process.platform === "linux" ? "read-only" : "danger-full-access";
  expect(build({ configMode: "read-only" }).confinement).toBe(deployment);
  expect(build({}).confinement).toBe(
    process.platform === "linux" ? "workspace-write" : "danger-full-access",
  );

  // The escalation's approval id carries the rung it asked for, so the
  // response's session grant can be applied to the ladder.
  approvals.length = 0;
  await widened.sandboxApprover.request({
    requestedMode: "read-only",
    justification: "tightening for the install",
  });
  expect(approvals).toEqual(["run_shell:sandbox:read-only"]);
});

test("the main agent's write authorize refuses a symlink escape", async () => {
  // The containment every write path answers to (洞 2's acceptance): the
  // context's `workspaceWriteAuthorize` is wired to the policy home's
  // landed judgement, so a symlink inside the workspace spelling its way
  // out is refused rather than waved through by the lexical check.
  const { buildToolExecutionContext } = await import(
    "../src/runtime/tool-execution/execute-context"
  );
  const root = await mkdtemp(join(tmpdir(), "natalia-ctx-containment-"));
  const outside = await mkdtemp(join(tmpdir(), "natalia-ctx-out-"));
  const ctx = {
    state: { serviceDirectory: { getOptional: () => undefined } },
    ports: {
      getTsRuntimeConfig: () => ({ confinement: {}, runtime: {} }),
      getInteractive: () => undefined,
      getCapabilityRegistry: () => ({ service: () => undefined }),
      authorizeWorkspaceRead: async () => undefined,
      authorizeSandboxMerge: async () => undefined,
      toolSettings: () => ({}),
      scheduleRuntimeStatusSnapshot: () => undefined,
    },
  } as never;
  const context = buildToolExecutionContext({
    ctx,
    exec: { session: { id: "ses_ctx" } } as never,
    publish: () => undefined,
    toolID: "write_file",
    tool: { name: "write_file" } as never,
    call: { id: "call_1" } as never,
    turnID: "turn_1",
    sessionID: "ses_ctx" as never,
    workspaceRoot: root,
    signal: new AbortController().signal,
    parsed: {},
  });
  try {
    await mkdir(join(root, "allowed"), { recursive: true });
    await writeFile(join(root, "allowed", "inside.txt"), "x");
    // A junction on Windows: an unprivileged process cannot create a
    // directory symlink there (EPERM), and realpath resolves a junction
    // the same way — the property under test is the escape detection,
    // not the link kind.
    await symlink(
      outside,
      join(root, "allowed", "link"),
      process.platform === "win32" ? "junction" : "dir",
    );
    // Inside: allowed.
    await context.workspaceWriteAuthorize?.({
      toolName: "write_file",
      path: join(root, "allowed", "inside.txt"),
    });
    // Through the link: refused, and the refusal names the rule, the path
    // and the reason (the structured refusal).
    await expect(
      context.workspaceWriteAuthorize?.({
        toolName: "write_file",
        path: join(root, "allowed", "link", "escaped.txt"),
      }),
    ).rejects.toThrow(/lands outside the workspace/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
