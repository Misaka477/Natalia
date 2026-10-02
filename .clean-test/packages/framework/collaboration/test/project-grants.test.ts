import { expect, test } from "bun:test";
import type {
  ApprovalResponse,
  RuntimeEvent,
  SessionID,
} from "@anthelia/contracts";
import type { ProviderToolCall } from "@anthelia/runtime";
import type { RuntimeTool } from "@anthelia/tools";
import { createInteractiveWaiter } from "../src/interactive-waiter";
import { projectGrantFamilies } from "../src/project-grants";
import { createWorkLedgerController } from "@natalia/work-ledger";

/**
 * The project approval tier ("always allow in this project"): the
 * standing grant, its durable record (the journal's approval.response
 * with decision "project"), the restore fold, and the forced-approval
 * gate (git writes never offer project grants).
 */

const tool = (name: string): RuntimeTool => ({
  name,
  description: name,
  requiresApproval: true,
  parameters: { type: "object", properties: {} },
  async execute() {
    return "ok";
  },
});

const call = (id: string, name: string, args = {}): ProviderToolCall => ({
  id,
  name,
  arguments: JSON.stringify(args),
});

/** A harness whose auto-responder answers with a settable decision. */
function harness(options: {
  session?: SessionID;
  decision?: ApprovalResponse["decision"];
  force?: boolean;
  journal?: RuntimeEvent[];
}) {
  const session = options.session ?? ("ses_a" as SessionID);
  const events: RuntimeEvent[] = [...(options.journal ?? [])];
  let waiter: ReturnType<typeof createInteractiveWaiter>;
  waiter = createInteractiveWaiter({
    publish: (event) => events.push(event),
    publishForSession: (_session, event) => {
      events.push(event);
      if (event.type === "approval.request")
        waiter.respondApproval({
          requestID: event.id,
          decision: options.decision ?? "session",
        });
    },
    sessionID: () => session,
    sessionIDForTurn: () => session,
    permissionMode: () => "ask",
    abortSignal: () => undefined,
    activeTurnID: () => undefined,
    isPending: () => false,
    workLedger: () =>
      createWorkLedgerController({ openFindingIDs: () => new Set() }),
    sessionEvents: () => events,
  });
  const approvalOption = (id: string) =>
    events.find(
      (event) => event.type === "approval.request" && event.id === id,
    );
  return {
    waiter,
    events,
    requests: () => events.filter((event) => event.type === "approval.request"),
    approvalOption,
  };
}

test("a project decision grants the family project-wide", async () => {
  const h = harness({ decision: "project" });
  await h.waiter.requireApproval(
    "a",
    tool("write_file"),
    call("a", "write_file"),
    "turn_a",
  );
  expect(h.waiter.projectGrantedFamilies()).toEqual(["filesystem-write"]);
  // The second call in the SAME family asks nobody: the standing grant
  // answers it (the request count does not move).
  const before = h.requests().length;
  await h.waiter.requireApproval(
    "b",
    tool("edit_file"),
    call("b", "edit_file"),
    "turn_b",
  );
  expect(h.requests().length).toBe(before);
});

test("a project grant survives the session switch (it is project, not session)", async () => {
  const h = harness({ decision: "project", session: "ses_a" as SessionID });
  await h.waiter.requireApproval(
    "a",
    tool("write_file"),
    call("a", "write_file"),
    "turn_a",
  );
  // A different session: the SESSION grant would not carry, the PROJECT
  // one does — that is the tier's whole point.
  await h.waiter.requireApproval(
    "b",
    tool("write_file"),
    call("b", "write_file"),
    "turn_b",
  );
  expect(h.requests().length).toBe(1);
});

test("the restore fold seeds the project grants from the journal", async () => {
  // The durable record: an approval.response with decision "project"
  // answering its request. A fresh runtime (a restart) folds it and the
  // first approval of the session asks nobody.
  const journal: RuntimeEvent[] = [
    {
      type: "approval.request",
      id: "req_1",
      title: "Approve write_file",
      preview: "write_file",
      permissionFamily: {
        id: "filesystem-write",
        label: "写文件",
        summary: "writes the workspace",
      },
    } as unknown as RuntimeEvent,
    {
      type: "approval.response",
      id: "req_1",
      decision: "project",
    },
  ];
  const h = harness({ journal });
  await h.waiter.requireApproval(
    "a",
    tool("write_file"),
    call("a", "write_file"),
    "turn_a",
  );
  expect(h.waiter.projectGrantedFamilies()).toEqual(["filesystem-write"]);
  expect(h.requests().length).toBe(1); // only the seeded journal's request
});

test("the fold grants nothing from an unpaired response", () => {
  expect(
    projectGrantFamilies([
      {
        type: "approval.response",
        id: "orphan",
        decision: "project",
      } as unknown as RuntimeEvent,
    ]),
  ).toEqual([]);
  expect(
    projectGrantFamilies([
      {
        type: "approval.request",
        id: "req_1",
        title: "t",
        preview: "p",
        permissionFamily: {
          id: "filesystem-write",
          label: "写",
          description: "writes the workspace",
          scope: "workspace",
          sessionAction: "allow-session",
        },
      } as unknown as RuntimeEvent,
      {
        type: "approval.response",
        id: "req_1",
        decision: "session",
      } as unknown as RuntimeEvent,
    ]),
  ).toEqual([]);
});

test("a forced approval offers no project grant (the request says so)", async () => {
  const h = harness({ decision: "project", force: true });
  await h.waiter.requireApproval(
    "a",
    tool("write_file"),
    call("a", "write_file"),
    "turn_a",
    { force: true, reason: "a rule-class change" },
  );
  const request = h
    .requests()
    .find((event) => event.type === "approval.request");
  expect(request).toMatchObject({ allowProject: false, allowSession: false });
});
