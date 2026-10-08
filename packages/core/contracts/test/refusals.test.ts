import { expect, test } from "bun:test";
import {
  REQUIRED_RUNTIME_MEMBERS,
  RUNTIME_CAPABILITY_GROUPS,
  capabilityGroupOf,
} from "../src/capabilities";
import {
  RUNTIME_MEMBER_REFUSAL_SEMANTICS,
  membersRefusingByValue,
} from "../src/refusals";

/**
 * The decision table says, per member, how a caller learns the call did not
 * happen. Completeness is enforced by the compiler; these tests pin the parts a
 * type cannot: that every member is actually covered at runtime too, and that the
 * set of members which must answer with a value is a deliberate list rather than
 * whatever the last edit left behind.
 */

test("every member has a decision, and nothing else does", () => {
  const members = [
    ...REQUIRED_RUNTIME_MEMBERS,
    ...Object.values(RUNTIME_CAPABILITY_GROUPS).flat(),
  ].sort();
  expect(Object.keys(RUNTIME_MEMBER_REFUSAL_SEMANTICS).sort()).toEqual(members);
});

test("the members whose refusal must be a value are named, and each names its field", () => {
  // Adding one is a contract change with implementations to update, so it should
  // require touching this list on purpose. Removing one — regressing to a throw or
  // to a hard-coded success — is caught by the behavioural tests in
  // packages/framework/client and packages/tooling/sdk.
  expect(membersRefusingByValue()).toEqual([
    "acknowledgeDriftFinding",
    "agentCreate",
    "agentDelete",
    "approveOverride",
    "canReloadConfig",
    "createConstitutionRule",
    "evaluateDrift",
    "externalBenchmark",
    "feedback",
    "goalControl",
    "goalEdit",
    "growthPropose",
    "mailboxAcknowledge",
    "mailboxDefer",
    "mailboxDeliver",
    "mailboxSend",
    "mailboxSupersede",
    "mcpServerAdd",
    "mcpServerRemove",
    "pause",
    "permissionDelete",
    "permissionSave",
    "planDocActivate",
    "planDocDeactivate",
    "planDocDelete",
    "planDocMark",
    "planDocPause",
    "planDocUpdateStatus",
    "planDocWrite",
    "pluginInstall",
    "pluginSetEnabled",
    "pluginUninstall",
    "pluginUnload",
    "promoteConstitutionDocRule",
    "promoteGrowthTrigger",
    "promoteInput",
    "providerAdd",
    "providerRemove",
    "recordCompletion",
    "recordDecision",
    "recordExternalRun",
    "recordHumanValidation",
    "recordValidation",
    "reloadConfig",
    "removeConstitutionRule",
    "removeInput",
    "reopenDriftFinding",
    "replaceInput",
    "requestOverride",
    "respondApproval",
    "respondInteractive",
    "respondQuestion",
    "resume",
    "selectAgent",
    "sessionArchive",
    "sessionNew",
    "setDefaultModel",
    "shutdown",
    "updateConfig",
    "updateConstitutionDocRule",
    "updateConstitutionRule",
    "workspaceCreate",
    "workspaceDelete",
    "workspaceRename",
    "workspaceWrite",
  ]);
  for (const [member, semantics] of Object.entries(
    RUNTIME_MEMBER_REFUSAL_SEMANTICS,
  )) {
    if (semantics.refusal !== "value") continue;
    expect(semantics.expressedBy.length).toBeGreaterThan(0);
    expect(member.length).toBeGreaterThan(0);
  }
});

test("every decision carries a reason a reader can check", () => {
  // A table of bare verdicts would be unreviewable: the note is what lets someone
  // disagree with a row.
  for (const semantics of Object.values(RUNTIME_MEMBER_REFUSAL_SEMANTICS))
    expect((semantics.note ?? "").length).toBeGreaterThan(0);
});

test("a member's capability comes from the capability table, not a second list", () => {
  // `-32000 not supported` carries the group so a consumer can switch off a whole
  // feature area; a hand-maintained copy of that mapping is the thing that rots.
  expect(capabilityGroupOf("checkpointRollback")).toBe("checkpoint");
  expect(capabilityGroupOf("nativeTerminalStop")).toBe("nativeTerminal");
  // Required members belong to no group: a runtime missing one is unusable, not
  // degraded.
  for (const member of REQUIRED_RUNTIME_MEMBERS)
    expect(capabilityGroupOf(member)).toBeUndefined();
  expect(capabilityGroupOf("notAMember")).toBeUndefined();
});
