import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  confinementAvailable,
  ESCALATION_TARGETS,
} from "@anthelia/confinement";
import { shellToolFamily } from "../src";

/**
 * The run_shell escalation chain end-to-end through the tool: schema
 * advertisement, pairing validation, the approval choreography riding the
 * runtime's approver closure, and the denial markers when the kernel
 * refuses a confined write.
 *
 * The directories live inside the package (outside every temp root), so a
 * workspace-write denial of the sibling can never be masked by the
 * always-granted `/tmp`.
 */

const tool = shellToolFamily().tools.find(
  (candidate) => candidate.name === "run_shell",
)!;
const available = confinementAvailable();
let workspace = "";
let outside = "";

beforeAll(() => {
  const base = join(import.meta.dir, `.shell-escalation-${process.pid}`);
  workspace = join(base, "workspace");
  outside = join(base, "outside");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(outside, { recursive: true });
});

afterAll(() => {
  rmSync(join(import.meta.dir, `.shell-escalation-${process.pid}`), {
    recursive: true,
    force: true,
  });
});

type Outcome = "allowed-once" | "rejected" | "cancelled" | "unavailable";
function context(input?: {
  confinement?: "read-only" | "workspace-write" | "danger-full-access";
  outcome?: Outcome;
  asks?: Array<{ requestedMode: string; justification: string }>;
}) {
  const { outcome = "allowed-once", asks } = input ?? {};
  return {
    workspaceRoot: workspace,
    settings: {},
    confinement: input?.confinement ?? "workspace-write",
    sandboxApprover: {
      request: async (request: {
        requestedMode: string;
        justification: string;
      }) => {
        asks?.push(request);
        return outcome;
      },
    },
  } as never;
}

test("the schema advertises the escalation fields", () => {
  const schema = tool.parameters as {
    properties: Record<string, { type: string; enum?: string[] }>;
  };
  expect(schema.properties.sandbox_permissions?.enum).toEqual([
    ...ESCALATION_TARGETS,
  ]);
  expect(schema.properties.justification?.type).toBe("string");
});

test("sandbox_permissions without justification is refused before running", async () => {
  await expect(
    tool.execute(
      { command: "echo hi", sandbox_permissions: "danger-full-access" },
      context(),
    ),
  ).rejects.toThrow(/requires a justification/u);
});

test("repeating the current mode runs without asking", async () => {
  if (!available) return;
  const asks: Array<{ requestedMode: string; justification: string }> = [];
  const target = join(workspace, "same.txt");
  const output = await tool.execute(
    {
      command: `echo ok > "${target}"`,
      sandbox_permissions: "workspace-write",
      justification: "same as current",
    },
    context({ asks }),
  );
  expect(asks).toEqual([]);
  expect(output).toContain("exit=0");
});

test("a granted wider mode applies to this call only", async () => {
  if (!available) return;
  const asks: Array<{ requestedMode: string; justification: string }> = [];
  const target = join(outside, "granted.txt");
  const output = await tool.execute(
    {
      command: `echo ok > "${target}"`,
      sandbox_permissions: "danger-full-access",
      justification:
        "the audit pass must write its report outside the workspace",
    },
    context({ outcome: "allowed-once", asks }),
  );
  expect(asks).toEqual([
    {
      requestedMode: "danger-full-access",
      justification:
        "the audit pass must write its report outside the workspace",
    },
  ]);
  expect(output).toContain("exit=0");
  expect(await Bun.file(target).exists()).toBe(true);
});

test("a refusal surfaces the reference wording and does not run", async () => {
  const target = join(outside, "refused.txt");
  await expect(
    tool.execute(
      {
        command: `echo ok > "${target}"`,
        sandbox_permissions: "danger-full-access",
        justification: "trust me",
      },
      context({ outcome: "rejected" }),
    ),
  ).rejects.toThrow(
    'the user rejected escalating this command to "danger-full-access"',
  );
  expect(await Bun.file(target).exists()).toBe(false);
});

test("a kernel denial names the mode and offers the sanctioned retry", async () => {
  if (!available) return;
  const blocked = join(outside, "denied.txt");
  const error = await tool
    .execute({ command: `echo bad > "${blocked}"` }, context())
    .then(
      () => undefined,
      (thrown: Error) => thrown.message,
    );
  expect(error).toBeDefined();
  expect(error).toContain(
    "[sandbox: file access denied under workspace-write mode]",
  );
  // A wider mode exists, so the hint rides along.
  expect(error).toContain(
    "retry this exact command once with sandbox_permissions",
  );
  expect(await Bun.file(blocked).exists()).toBe(false);
});
