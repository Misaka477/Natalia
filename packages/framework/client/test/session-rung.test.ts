/**
 * The rung is a SESSION-level pair, and the model is told — through the tail,
 * never the cached system prompt.
 *
 * Measured defect this pins: the permission selector used to write the config
 * (`updateConfig`, scope "global") and re-read it. Because `resolveConfig`
 * merges defaults -> global -> project, a workspace that pins
 * `defaultAgentMode` / `confinement.mode` in its own `.natalia/config.json`
 * outranked that write, so:
 *
 *   - the axes read back UNCHANGED (the selector could never move),
 *   - `exec.permissionMode` never changed, so the per-turn environment block's
 *     `Permission mode:` line kept stating the old mode (the agent never knew),
 *   - and the only visible effect was the `config.reload` the write triggered.
 *
 * The fix is session-scoped: one write moves both axes, the environment block
 * states the pair on the next turn, and a later config reload leaves a session
 * the human moved alone.
 */
import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeEvent, SessionID } from "@anthelia/contracts";
import type { ProviderStreamRequest } from "@anthelia/runtime";
import { permissionModeFromEvents } from "@anthelia/session";
import { createRealRuntimeClient } from "../src";

/** A provider that answers one text (or nothing) per turn, and records requests. */
function textOnlyProvider(
  answer: () => string | undefined,
  seen?: ProviderStreamRequest[],
) {
  return {
    provider: "test",
    model: "test",
    async *stream(request: ProviderStreamRequest) {
      seen?.push(request);
      const text = answer();
      if (text) yield { type: "text_delta", text } as never;
      yield { type: "done" } as never;
    },
  };
}

async function workspaceWithPinnedConfig(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "natalia-session-rung-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  // The user's own shape: the WORKSPACE pins both axes. This is the file a
  // global write could not beat, which is why the old selector was a no-op.
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      defaultAgentMode: "ask",
      confinement: { mode: "workspace-write" },
      agentModes: {
        ask: { description: "Ask before writing", approval: "ask" },
        auto: { description: "Write without asking", approval: "auto" },
        read_only: { description: "Read only", approval: "read_only" },
      },
    }),
  );
  return root;
}

test("moving the rung moves BOTH axes on the session, not the config", async () => {
  const root = await workspaceWithPinnedConfig();
  const sessionID = "ses_session_rung" as SessionID;
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID,
    permissionMode: "ask",
    provider: textOnlyProvider(() => undefined),
  });
  client.start((event) => events.push(event));
  try {
    await client.sessionAttach!(sessionID);

    // The config still says what the workspace pinned; the session moves anyway.
    const moved = await client.setSandboxRung!({
      mode: "danger-full-access",
      approval: "auto",
    });
    expect(moved).toMatchObject({
      changed: true,
      mode: "danger-full-access",
      approval: "auto",
    });

    // The approval axis has its own event (the status line reads it).
    const modeEvent = events.find(
      (event) => event.type === "session.permission.mode",
    );
    expect((modeEvent as { mode?: string } | undefined)?.mode).toBe("auto");

    // The model is told the PAIR through the durable instruction channel — the
    // same one a generation switch rides, never the static system prompt.
    const notice = events.find(
      (event) =>
        event.type === "context.instructions" &&
        (event as { kind?: string }).kind === "sandbox_rung",
    );
    expect(notice).toBeDefined();
    expect(String((notice as { summary?: string }).summary)).toContain(
      "approval is now auto",
    );
    expect(JSON.stringify((notice as { detail?: string[] }).detail)).toContain(
      "writes proceed without asking",
    );

    // The config file was NOT rewritten: a rung is a decision about this
    // conversation, and a config write is what produced the reload noise.
    const configText = await Bun.file(
      join(root, ".natalia", "config.json"),
    ).text();
    expect(configText).toContain('"defaultAgentMode":"ask"');
    expect(configText).toContain('"mode":"workspace-write"');
  } finally {
    await client.dispose?.();
  }
}, 60_000);

test("the next turn's environment block states the rung the session is on", async () => {
  const root = await workspaceWithPinnedConfig();
  const sessionID = "ses_rung_environment" as SessionID;
  const requests: ProviderStreamRequest[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID,
    permissionMode: "ask",
    provider: textOnlyProvider(() => "ok", requests),
  });
  client.start(() => undefined);
  try {
    await client.sessionAttach!(sessionID);

    await client.setSandboxRung!({ mode: "read-only", approval: "read_only" });
    await client.submitAndWait!("what may I do?");

    // The environment block is an APPENDED `<runtime_context>` user message, so
    // the already-cached prefix is untouched by the switch.
    const last = requests.at(-1);
    const text = JSON.stringify(last?.messages ?? []);
    expect(text).toContain('<runtime_context source=\\"environment\\"');
    // The approval axis: this is the line the agent reads to know whether a write
    // will ask, and it was frozen at the deployment's mode before the fix.
    expect(text).toContain("Permission mode: read_only");
  } finally {
    await client.dispose?.();
  }
}, 60_000);

test("a config reload does not stamp the deployment's mode over a session choice", async () => {
  const root = await workspaceWithPinnedConfig();
  const sessionID = "ses_rung_reload" as SessionID;
  const requests: ProviderStreamRequest[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID,
    permissionMode: "ask",
    provider: textOnlyProvider(() => undefined, requests),
  });
  client.start(() => undefined);
  try {
    await client.sessionAttach!(sessionID);
    await client.setSandboxRung!({ mode: "workspace-write", approval: "auto" });

    // The reload the OLD control triggered on every switch. It refreshes the
    // deployment default, and must leave the session's own choice alone.
    await client.reloadConfig?.();

    await client.submitAndWait!("still auto?");
    const text = JSON.stringify(requests.at(-1)?.messages ?? []);
    expect(text).toContain("Permission mode: auto");
  } finally {
    await client.dispose?.();
  }
}, 60_000);

/**
 * The same question one process later, which is where the in-process flag
 * cannot help.
 *
 * `reloadPermissionSettings` runs at INITIALIZE — before any attach has
 * reconciled the journal onto a freshly built exec — so for a session that
 * chose in an earlier process `permissionModeOverride` is still undefined and
 * the "a session that chose keeps its rung" guard does not fire. Publishing
 * the deployment default there wrote a durable `session.permission.mode` at the
 * TAIL of that session's journal, and the attach that followed read the tail:
 * the human's `auto` was overwritten by the default, durably, on every restart.
 *
 * Measured on the user's own store: a session on `auto` came back on
 * `read_only` with a fresh row naming the default.
 */
test("a reload does not write the deployment default over a journal's rung", async () => {
  const root = await workspaceWithPinnedConfig();
  const sessionID = "ses_rung_reload_journal" as SessionID;
  // A deployment whose default differs from the mode this client starts on, so
  // the reload's "only on a real change" guard actually fires.
  const first = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID,
    permissionMode: "read_only",
    provider: textOnlyProvider(() => undefined),
  });
  first.start(() => undefined);
  try {
    await first.sessionAttach!(sessionID);
    await first.setSandboxRung!({ mode: "workspace-write", approval: "auto" });
  } finally {
    await first.dispose?.();
  }

  // A second process: same workspace, same session, same store. The journal
  // carries the rung; nothing in this process chose one yet.
  const events: RuntimeEvent[] = [];
  const second = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID,
    permissionMode: "read_only",
    provider: textOnlyProvider(() => undefined),
  });
  second.start((event) => events.push(event));
  try {
    await second.sessionAttach!(sessionID);
    // Attach REPLAYS the journal, so the rung fact the first process wrote is
    // already here. The reload's write is what the delta measures.
    const beforeReload = events.filter(
      (event) => event.type === "session.permission.mode",
    ).length;

    await second.reloadConfig?.();

    const afterReload = events.filter(
      (event) => event.type === "session.permission.mode",
    ).length;
    // The reload may legitimately move a session that never chose in memory; it
    // must not write a durable fact HERE, over a journal that already records
    // the human's pair.
    expect(afterReload).toBe(beforeReload);
    const fold = permissionModeFromEvents(
      events.filter((event) => event.type !== "status.snapshot"),
    );
    expect(fold).toBe("auto");
  } finally {
    await second.dispose?.();
  }
}, 60_000);
