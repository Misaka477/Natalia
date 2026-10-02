import { expect, test } from "bun:test";
import type { RuntimeEvent, SessionID } from "@anthelia/contracts";
import type { ProviderStreamRequest } from "@anthelia/runtime";
import { projectedWorkContracts } from "@anthelia/session";
import { createRealRuntimeClient } from "../src";
import {
  officialPluginWorkspace,
  useWorkspaceCleanup,
} from "./plugin-test-helpers";

useWorkspaceCleanup();

/**
 * EI Open Question "契约 handoff 撞 constitution" — decided: 拦在 propose /
 * detour_declare (事前). A scope entry naming a path a deny constitution rule
 * covers is refused BEFORE the user gate and before the journal draft, so the
 * model re-proposes inside the existing feedback loop and the user never sees
 * a contract that cannot be executed.
 */
test("plan_propose refuses a scope naming a deny-covered path before the gate", async () => {
  const root = await officialPluginWorkspace("contract-constitution-propose");
  const sessionID = "ses_contract_constitution_propose" as SessionID;
  const events: RuntimeEvent[] = [];
  let planID = "";
  let approvals = 0;
  let contractPreview = "";
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID,
    permissionMode: "ask",
    provider: {
      provider: "plan-propose-constitution",
      model: "plan-propose-constitution-model",
      async *stream(request: ProviderStreamRequest) {
        const proposeResult = (
          request as {
            messages: Array<{
              role: string;
              content: string;
              toolCallID?: string;
            }>;
          }
        ).messages
          .filter(
            (message) =>
              message.role === "tool" &&
              String(message.toolCallID ?? "").startsWith("call_propose"),
          )
          .at(-1);
        if (!proposeResult) {
          // The bad proposal names secrets/key.pem, which the deny rule covers.
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "call_propose",
                name: "plan_propose",
                arguments: JSON.stringify({
                  planID,
                  scope: ["rotate the secrets/key.pem"],
                }),
              },
            ],
          };
          yield { type: "done" as const };
          return;
        }
        const result = String(proposeResult.content ?? "");
        if (result.includes('"accepted":false')) {
          // The refusal names the rule and the path; re-propose within it.
          expect(result).toContain(ruleID);
          expect(result).toContain("secrets/key.pem");
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "call_propose",
                name: "plan_propose",
                arguments: JSON.stringify({ planID, scope: ["packages/a"] }),
              },
            ],
          };
          yield { type: "done" as const };
          return;
        }
        // Ledger plan §5: the proposal displays its conflict-check result
        // at the user's decision point — the gate's preview names the deny
        // rules it was checked against and the verdict.
        expect(contractPreview).toContain(
          "constitution: checked against 1 deny rule(s) with path anchors — no conflict",
        );
        yield { type: "content" as const, text: "contract accepted" };
        yield { type: "done" as const };
      },
    },
  });
  client.start((event) => {
    events.push(event);
    if (event.type === "approval.request" && event.scope === "work_contract") {
      approvals += 1;
      contractPreview = event.preview ?? "";
      client.respondApproval({ requestID: event.id, decision: "once" });
    }
  });
  await client.sessionAttach!(sessionID);
  const created = await client.createConstitutionRule!(
    {
      statement: "never touch the secrets directory",
      enforcement: "deny",
      appliesTo: { paths: ["secrets/**"] },
    },
    sessionID,
  );
  const ruleID = created.ruleID!;
  await client.planDocWrite!({
    path: "plans/constitution-plan.md",
    content: "# Constitution plan\n\n- one concrete step\n",
    title: "Constitution plan",
  });
  const marked = await client.planDocMark!({
    path: "plans/constitution-plan.md",
    title: "Constitution plan",
  });
  planID = marked.planID;
  await client.planDocActivate!(planID);
  await client.submitAndWait!("propose the contract for the plan");

  // The gate fired exactly once — for the clean re-proposal only.
  expect(approvals).toBe(1);
  // The refused proposal never reached the journal as a draft.
  const drafted = events.filter(
    (event) => event.type === "work_contract.drafted",
  );
  expect(drafted).toHaveLength(1);
  expect(drafted[0]).toMatchObject({
    type: "work_contract.drafted",
    planID,
    scope: ["packages/a"],
  });
  const accepted = events.filter(
    (event) => event.type === "work_contract.accepted",
  );
  expect(accepted).toHaveLength(1);
  expect(
    projectedWorkContracts(events).find(
      (contract) => contract.planID === planID,
    ),
  ).toMatchObject({ status: "current", scope: ["packages/a"] });
  await client.dispose?.();
}, 30_000);

test("detour_declare refuses a scopeDelta naming a deny-covered path before the gate", async () => {
  const root = await officialPluginWorkspace("contract-constitution-detour");
  const sessionID = "ses_contract_constitution_detour" as SessionID;
  const events: RuntimeEvent[] = [];
  let planID = "";
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID,
    permissionMode: "ask",
    provider: {
      provider: "plan-detour-constitution",
      model: "plan-detour-constitution-model",
      async *stream(request: ProviderStreamRequest) {
        const toolResults = (
          request as {
            messages: Array<{
              role: string;
              content: string;
              toolCallID?: string;
            }>;
          }
        ).messages.filter((message) => message.role === "tool");
        const call = (
          name: string,
          args: Record<string, unknown>,
          id: string,
        ) => ({
          type: "tool_call" as const,
          calls: [{ id, name, arguments: JSON.stringify(args) }],
        });
        const latest = toolResults.at(-1);
        const latestContent = String(latest?.content ?? "");
        if (!toolResults.length) {
          // Clean contract first (the detour needs an accepted contract).
          yield call(
            "plan_propose",
            { planID, scope: ["packages/a"] },
            "call_propose",
          );
          yield { type: "done" as const };
          return;
        }
        if (
          String(latest?.toolCallID ?? "").startsWith("call_propose") &&
          latestContent.includes('"accepted":true')
        ) {
          // The bad detour names .env, which the deny rule covers.
          yield call(
            "detour_declare",
            {
              planID,
              currentVersion: 1,
              reason: "the fix also needs the credentials file",
              scopeDelta: ["rotate .env"],
            },
            "call_detour",
          );
          yield { type: "done" as const };
          return;
        }
        if (latestContent.includes('"accepted":false')) {
          // The refusal names the rule and the path; re-declare within it.
          expect(latestContent).toContain(ruleID);
          expect(latestContent).toContain(".env");
          yield call(
            "detour_declare",
            {
              planID,
              currentVersion: 1,
              reason: "the fix also needs the shared util package",
              scopeDelta: ["packages/b"],
            },
            "call_detour",
          );
          yield { type: "done" as const };
          return;
        }
        yield { type: "content" as const, text: "detour absorbed" };
        yield { type: "done" as const };
      },
    },
  });
  client.start((event) => {
    events.push(event);
    if (
      event.type === "approval.request" &&
      (event.scope === "work_contract" || event.scope === "detour")
    )
      client.respondApproval({ requestID: event.id, decision: "once" });
  });
  await client.sessionAttach!(sessionID);
  const created = await client.createConstitutionRule!(
    {
      statement: "never touch the environment file",
      enforcement: "deny",
      appliesTo: { paths: ["**/.env"] },
    },
    sessionID,
  );
  const ruleID = created.ruleID!;
  await client.planDocWrite!({
    path: "plans/constitution-detour.md",
    content: "# Constitution detour\n\n- one concrete step\n",
    title: "Constitution detour",
  });
  const marked = await client.planDocMark!({
    path: "plans/constitution-detour.md",
    title: "Constitution detour",
  });
  planID = marked.planID;
  await client.planDocActivate!(planID);
  await client.submitAndWait!("propose the contract then declare a detour");

  // The refused detour never reached the journal.
  const requested = events.filter((event) => event.type === "detour.requested");
  expect(requested).toHaveLength(1);
  expect(requested[0]).toMatchObject({
    planID,
    currentVersion: 1,
    scopeDelta: ["packages/b"],
  });
  expect(
    projectedWorkContracts(events).find(
      (contract) => contract.planID === planID,
    ),
  ).toMatchObject({
    status: "current",
    version: 2,
    scope: ["packages/a", "packages/b"],
  });
  await client.dispose?.();
}, 30_000);
