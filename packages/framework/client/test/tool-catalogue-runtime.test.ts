import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { interactiveTerminalToolAliases } from "@anthelia/tools";
import type { RuntimeEvent } from "@anthelia/contracts";
import { runtimeToolNames } from "../src/capabilities/tool-family-capabilities";
import {
  createOfficialRuntimeClient,
  officialPluginWorkspace as mkdtemp,
  useWorkspaceCleanup,
} from "./plugin-test-helpers";
import { waitFor } from "./real-runtime-harness";

useWorkspaceCleanup();

/**
 * The advertised catalogue is the registry the runtime actually assembles.
 *
 * `runtimeToolNames()` is the list a model asks about and a test pins
 * permission rows against, so a name it carries that no plugin ever registers
 * is a promise the model pays for: it calls the tool and gets "unknown tool".
 * This list used to carry `plan` (merged into the todo tools long ago) and a
 * `background_*` family, and omitted every collab/context/goal/record/
 * constitution/generation/work-graph tool. The other direction is just as
 * dishonest: a registered tool that is missing from the advertisement is a
 * capability the model never learns it has.
 *
 * Both directions are pinned here against a boot of the REAL plugin
 * distribution: the official plugins plus the framework-contributed families,
 * exactly what a session gets. Adding a tool now fails this test until it is
 * added to the list deliberately; removing one fails it the same way.
 */
test("the advertised tool names are the names the real runtime registers", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-catalogue-runtime-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({ version: 3 }),
  );

  const events: RuntimeEvent[] = [];
  const client = createOfficialRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_catalogue_runtime",
    provider: {
      provider: "catalogue",
      model: "catalogue-model",
      async *stream() {
        yield { type: "done" as const };
      },
    },
  });
  client.start((event) => events.push(event));
  await waitFor(() => events.some((event) => event.type === "session.ready"));

  const registered = new Set(
    events
      .filter(
        (event): event is Extract<RuntimeEvent, { type: "tool.registered" }> =>
          event.type === "tool.registered",
      )
      .map((event) => event.name),
  );
  await client.dispose?.();

  // Anti-vacuity: the boot must have assembled the catalogue, or the sweep
  // below passes over an empty tree.
  expect(registered.size).toBeGreaterThan(50);

  const advertised = new Set(runtimeToolNames());
  const aliasNames = Object.keys(interactiveTerminalToolAliases);

  // Direction 1 — no phantom: every advertised name is a name the registry
  // accepts, either a canonical registration or a declared alias whose target
  // is registered.
  for (const name of advertised) {
    if (registered.has(name)) continue;
    const target =
      interactiveTerminalToolAliases[
        name as keyof typeof interactiveTerminalToolAliases
      ];
    expect(
      target,
      `advertised tool "${name}" is not registered and is not a declared alias`,
    ).toBeDefined();
    expect(
      registered.has(target),
      `alias "${name}" points at unregistered tool "${target}"`,
    ).toBe(true);
  }

  // Direction 2 — no silent capability: every registered tool is advertised.
  for (const name of registered)
    expect(advertised.has(name), `unadvertised tool: ${name}`).toBe(true);

  // The alias surface itself: exactly the declared aliases, no more. A new
  // alias the map gains must reach the advertisement, and an alias the map
  // loses must leave it.
  expect(aliasNames.every((alias) => advertised.has(alias))).toBe(true);
  for (const name of advertised)
    if (!registered.has(name))
      expect(
        aliasNames.includes(name),
        `"${name}" is advertised outside the registry and outside the alias map`,
      ).toBe(true);
}, 120_000);

test("interactive_observe reaches the tool whose name sits outside the family (F8)", () => {
  // The 2026-10-10 sweep's F8: the observation tool's canonical name is
  // `terminal_observe` — the only name outside the `interactive_terminal_*`
  // family. A model that learned the family's shape reaches for a name that
  // does not exist and gets "No tool output found for function call".
  expect(interactiveTerminalToolAliases.interactive_observe).toBe(
    "terminal_observe",
  );
  // And the alias's target is a name the runtime registers.
  expect(runtimeToolNames()).toContain("terminal_observe");
  expect(runtimeToolNames()).toContain("interactive_observe");
});
