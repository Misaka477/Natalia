/**
 * The pane's sandbox is chosen when it starts, and the model asks for a
 * wider one exactly like it does for the one-shot shell tool.
 *
 * The policy in full: a pane is a REAL shell, so its mode is fixed at the
 * spawn — no later call can widen a process that is already running. That
 * makes `interactive_terminal_start` the one place in the terminal family
 * that can escalate, and the field belongs there and only there: a
 * `sandbox_permissions` on a read or a keystroke would advertise a control
 * that does nothing (AGENTS.md §6). The rule it follows is the shell tool's:
 * a wider mode is per call, travels with a justification, and the user
 * approves it before anything spawns.
 */
import { expect, test } from "bun:test";
import { ESCALATION_TARGETS } from "@anthelia/confinement";
import { terminalTools } from "../src/terminal-tools";

function startTool() {
  const tool = terminalTools().find(
    (candidate) => candidate.name === "interactive_terminal_start",
  );
  if (!tool) throw new Error("interactive_terminal_start is not registered");
  return tool;
}

test("the start tool declares the escalation fields with real descriptions", () => {
  const properties = startTool().parameters.properties as Record<
    string,
    { enum?: string[]; description?: string }
  >;
  expect(properties.sandbox_permissions?.enum).toEqual([...ESCALATION_TARGETS]);
  // A description the model can act on: what the field does, that the grant
  // is one pane's lifetime, and that it travels with a justification.
  const description = properties.sandbox_permissions?.description ?? "";
  expect(description.length).toBeGreaterThan(80);
  expect(description).toContain("pane");
  expect(description).toContain("justification");
  expect((properties.justification?.description ?? "").length).toBeGreaterThan(
    20,
  );
});

test("every model-facing execution tool carries the escalation fields", () => {
  const byName = new Map(
    terminalTools().map((tool) => [tool.name, tool] as const),
  );
  // The four execution tools the model drives a pane with. Each declares the
  // same two fields with descriptions the model can act on: what a grant
  // approves, that a pane's mode is fixed at start, and that the two fields
  // travel together.
  for (const name of [
    "interactive_terminal_read",
    "interactive_terminal_search",
    "interactive_terminal_write",
    "interactive_terminal_input",
  ]) {
    const properties = byName.get(name)?.parameters.properties as Record<
      string,
      { enum?: string[]; description?: string }
    >;
    expect(properties?.sandbox_permissions?.enum, name).toEqual([
      ...ESCALATION_TARGETS,
    ]);
    expect(
      properties?.sandbox_permissions?.description?.length ?? 0,
      name,
    ).toBeGreaterThan(80);
    expect(
      properties?.justification?.description?.length ?? 0,
      name,
    ).toBeGreaterThan(20);
  }
});

test("a malformed escalation is refused before the tool touches a pane", async () => {
  const tool = terminalTools().find(
    (candidate) => candidate.name === "interactive_terminal_write",
  );
  if (!tool) throw new Error("interactive_terminal_write is not registered");
  // The justification without its mode: the shared validator refuses it, and
  // it does so BEFORE the tool's own execute — which would otherwise reach for
  // a pane this context does not have and fail for the wrong reason.
  await expect(
    tool.execute?.(
      { id: "terminal_x", input: "rm -rf /", justification: "because" },
      { workspaceRoot: "C:\\workspace" } as never,
    ),
  ).rejects.toThrow(/sandbox_permissions/u);
});

test("an escalation without its justification is refused before a spawn", () => {
  const tool = startTool();
  expect(tool.parameters.required ?? []).not.toContain("sandbox_permissions");
  // The guard runs in execute before anything is created; a missing
  // justification with a requested mode is refused by the shared validator.
  const context = {
    workspaceRoot: "C:\\workspace",
    sandboxApprover: {
      approve: () => {
        throw new Error("must not be reached: the arguments are refused first");
      },
    },
  };
  expect(
    tool.execute?.(
      { sandbox_permissions: ESCALATION_TARGETS[0] },
      context as never,
    ),
  ).rejects.toThrow(/justification/u);
});

/** A context whose terminal registry reports one pane with the given owner. */
function contextWithPane(inputOwner: "model" | "human" | undefined) {
  return {
    workspaceRoot: "C:\\workspace",
    terminal: {
      list: async () =>
        inputOwner === undefined
          ? []
          : [
              {
                id: "terminal_pane",
                host: "pty",
                paneID: 1,
                windowID: 1,
                muxWindowID: 1,
                tabID: 1,
                command: "pwsh",
                cwd: "C:\\workspace",
                status: "running",
                startedAt: "2026-10-16T00:00:00.000Z",
                inputOwner,
              },
            ],
    },
  } as never;
}

test("a pane the human owns is never asked about; a pane the model owns always is", async () => {
  const read = terminalTools().find(
    (candidate) => candidate.name === "interactive_terminal_read",
  );
  const write = terminalTools().find(
    (candidate) => candidate.name === "interactive_terminal_write",
  );
  if (!read?.approvalFor || !write?.approvalFor)
    throw new Error("the pane tools lost their per-call approval");
  // The rule is about the pane and not the operation: a read of the human's
  // pane is not asked about, a read of the model's is.
  expect(
    await read.approvalFor({ id: "terminal_pane" }, contextWithPane("human")),
  ).toBe(false);
  expect(
    await read.approvalFor({ id: "terminal_pane" }, contextWithPane("model")),
  ).toBe(true);
  expect(
    await write.approvalFor({ id: "terminal_pane" }, contextWithPane("human")),
  ).toBe(false);
  expect(
    await write.approvalFor({ id: "terminal_pane" }, contextWithPane("model")),
  ).toBe(true);
});

test("no pane named, or no registry, falls back to the tool's own flag", async () => {
  const read = terminalTools().find(
    (candidate) => candidate.name === "interactive_terminal_read",
  );
  const write = terminalTools().find(
    (candidate) => candidate.name === "interactive_terminal_write",
  );
  if (!read?.approvalFor || !write?.approvalFor)
    throw new Error("the pane tools lost their per-call approval");
  // No id: read is a read tool (false), write is a write tool (true).
  expect(await read.approvalFor({}, contextWithPane(undefined))).toBe(false);
  expect(await write.approvalFor({}, contextWithPane(undefined))).toBe(true);
  // No registry at all: the same fallback, never a silent allow.
  expect(
    await write.approvalFor({ id: "terminal_pane" }, {
      workspaceRoot: "C:\\",
    } as never),
  ).toBe(true);
});
