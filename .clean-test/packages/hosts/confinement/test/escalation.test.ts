import { expect, test } from "bun:test";
import {
  ESCALATION_TARGETS,
  WIDER_MODES,
  approveEscalation,
  confinementContextLine,
  escalationHintMarker,
  sandboxDenialMarker,
  validateEscalationArgs,
} from "../src/escalation";

test("the escalation targets are exactly the modes above the floor", () => {
  expect([...ESCALATION_TARGETS]).toEqual([
    "workspace-write",
    "danger-full-access",
  ]);
  expect(WIDER_MODES["danger-full-access"]).toEqual([]);
  expect(WIDER_MODES["read-only"]).toContain("workspace-write");
  // Strictly wider only: danger is never reachable from workspace-write and
  // back.
  expect(WIDER_MODES["workspace-write"]).not.toContain("read-only");
});

test("sandbox_permissions and justification travel together", () => {
  expect(() => validateEscalationArgs("danger-full-access", undefined)).toThrow(
    /requires a justification/,
  );
  expect(() => validateEscalationArgs(undefined, "because")).toThrow(
    /only valid together/,
  );
  expect(() => validateEscalationArgs("danger-full-access", "   ")).toThrow(
    /non-empty sentence/,
  );
  expect(() =>
    validateEscalationArgs("danger-full-access", "need /etc for the audit"),
  ).not.toThrow();
  expect(() => validateEscalationArgs(undefined, undefined)).not.toThrow();
});

test("repeating the effective mode needs no approval", async () => {
  let asked = 0;
  const granted = await approveEscalation(
    {
      requestedMode: "workspace-write",
      justification: "same as current",
      effectiveMode: "workspace-write",
      subject: "command",
    },
    {
      approver: {
        async request() {
          asked += 1;
          return "allowed-once";
        },
      },
      toolName: "run_shell",
    },
  );
  expect(granted).toBe("workspace-write");
  expect(asked).toBe(0);
});

test("a strictly wider mode asks once and grants for this call", async () => {
  const asks: Array<{ requestedMode: string; justification: string }> = [];
  const granted = await approveEscalation(
    {
      requestedMode: "danger-full-access",
      justification: "the audit tool must read /etc/hosts",
      effectiveMode: "workspace-write",
      subject: "command",
    },
    {
      approver: {
        async request(input) {
          asks.push(input);
          return "allowed-once";
        },
      },
      toolName: "run_shell",
    },
  );
  expect(granted).toBe("danger-full-access");
  expect(asks).toEqual([
    {
      requestedMode: "danger-full-access",
      justification: "the audit tool must read /etc/hosts",
    },
  ]);
});

test("a refusal throws before anything executes (dsh texts)", async () => {
  const refusal = async () => "rejected" as const;
  await expect(
    approveEscalation(
      {
        requestedMode: "danger-full-access",
        justification: "trust me",
        effectiveMode: "workspace-write",
        subject: "command",
      },
      { approver: { request: refusal }, toolName: "run_shell" },
    ),
  ).rejects.toThrow(
    'the user rejected escalating this command to "danger-full-access"',
  );
});

test("no approval channel fails closed as unavailable", async () => {
  await expect(
    approveEscalation(
      {
        requestedMode: "danger-full-access",
        justification: "trust me",
        effectiveMode: "workspace-write",
        subject: "command",
      },
      { approver: undefined, toolName: "run_shell" },
    ),
  ).rejects.toThrow(/no approval channel is available/u);
});

test("narrowing is not escalation", async () => {
  await expect(
    approveEscalation(
      {
        requestedMode: "workspace-write",
        justification: "narrower",
        effectiveMode: "danger-full-access",
        subject: "command",
      },
      { approver: undefined, toolName: "run_shell" },
    ),
  ).rejects.toThrow(/not strictly wider/u);
});

test("an unknown future outcome fails with a named error (fallback discipline)", async () => {
  await expect(
    approveEscalation(
      {
        requestedMode: "danger-full-access",
        justification: "future channel",
        effectiveMode: "workspace-write",
        subject: "command",
      },
      {
        approver: {
          request: async () => "quantum-granted" as never,
        },
        toolName: "run_shell",
      },
    ),
  ).rejects.toThrow(/unknown escalation outcome: quantum-granted/u);
});

test("the model-facing markers keep the reference wording", () => {
  expect(sandboxDenialMarker("workspace-write")).toBe(
    "[sandbox: file access denied under workspace-write mode]",
  );
  expect(escalationHintMarker("command")).toContain(
    "retry this exact command once with sandbox_permissions",
  );
  expect(escalationHintMarker("command")).toContain(
    "the approval prompt asks the user",
  );
});

test("the context line states the mode and targets for the environment block", () => {
  // The production form of the agent layer: one environment-block line,
  // rendered per turn in the dynamic layer (the cached prefix is untouched).
  const line = confinementContextLine("workspace-write");
  expect(line).toContain("Confinement mode: workspace-write");
  expect(line).toContain("OS-level wrapper");
  expect(line).toContain("targets: danger-full-access");
  expect(confinementContextLine("read-only")).toContain(
    "targets: workspace-write, danger-full-access",
  );
  // The top mode: no wider target, stated.
  expect(confinementContextLine("danger-full-access")).toContain(
    "no wider mode exists from here",
  );
});
