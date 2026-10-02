import { expect, test } from "bun:test";
import type { RuntimeClient } from "../src/events";
import {
  API_STABLE_SURFACE,
  API_VERSION,
  describeRuntimeCapabilities,
  REQUIRED_RUNTIME_MEMBERS,
  RUNTIME_CAPABILITY_GROUPS,
  UNIMPLEMENTED_QUERIES,
} from "../src/capabilities";

/**
 * The point of this surface is that a consumer can tell three states apart that
 * `optional` cannot: "this runtime does not do that", "nobody implemented that
 * yet", and "there is genuinely nothing to report". These tests pin exactly that.
 */

function stub(members: string[]): RuntimeClient {
  return Object.fromEntries(
    members.map((member) => [member, () => undefined]),
  ) as unknown as RuntimeClient;
}

test("a runtime with only the required members is usable and reports no capabilities", () => {
  const report = describeRuntimeCapabilities(
    stub([...REQUIRED_RUNTIME_MEMBERS]),
  );
  expect(report.usable).toBe(true);
  expect(report.missingRequired).toEqual([]);
  expect(report.groups.filter((group) => group.available)).toEqual([]);
  // Nothing is claimed to be present, so nothing is reported as empty-for-now.
  expect(report.unimplemented).toEqual([]);
});

test("a runtime missing a required member is reported unusable, not degraded", () => {
  // Feature-detecting your way around a missing `submit` is not a degraded mode:
  // there is no runtime without it, and saying so is the point of the tier.
  const report = describeRuntimeCapabilities(
    stub(REQUIRED_RUNTIME_MEMBERS.filter((member) => member !== "submit")),
  );
  expect(report.usable).toBe(false);
  expect(report.missingRequired).toEqual(["submit"]);
});

test("a capability is available only when all of its members are", () => {
  const checkpoint = [...RUNTIME_CAPABILITY_GROUPS.checkpoint];
  const whole = describeRuntimeCapabilities(
    stub([...REQUIRED_RUNTIME_MEMBERS, ...checkpoint]),
  ).groups.find((group) => group.name === "checkpoint");
  expect(whole).toMatchObject({ available: true, partial: false, missing: [] });

  // Half a capability is worth reporting: it is usually an oversight, and a
  // consumer that checked one method would be surprised by the next.
  const half = describeRuntimeCapabilities(
    stub([...REQUIRED_RUNTIME_MEMBERS, checkpoint[0]!]),
  ).groups.find((group) => group.name === "checkpoint");
  expect(half).toMatchObject({ available: false, partial: true });
  expect(half?.missing).toEqual(checkpoint.slice(1));
});

test("a query that answers with nothing says why, instead of looking like no data", () => {
  const members = Object.keys(UNIMPLEMENTED_QUERIES) as Array<
    keyof typeof UNIMPLEMENTED_QUERIES
  >;
  // The intelligence group also holds implemented writers (recordDecision),
  // so stub the whole group plus the unimplemented query members.
  const report = describeRuntimeCapabilities(
    stub([
      ...REQUIRED_RUNTIME_MEMBERS,
      ...RUNTIME_CAPABILITY_GROUPS.intelligence,
      ...members,
    ]),
  );
  expect(report.unimplemented.map((entry) => entry.member).sort()).toEqual(
    [...members].sort(),
  );
  for (const entry of report.unimplemented)
    expect(entry.reason.length).toBeGreaterThan(0);
  // And it is still reported as present, because it is: it answers, with nothing.
  expect(
    report.groups.find((group) => group.name === "intelligence")?.available,
  ).toBe(true);
});

test("every member of the contract is either required or in exactly one capability", () => {
  // The compile-time check in `capabilities.ts` proves nothing is unclassified.
  // This proves the other half: nothing is classified twice, which would make a
  // report contradict itself.
  const seen = new Map<string, string[]>();
  for (const [name, members] of Object.entries(RUNTIME_CAPABILITY_GROUPS))
    for (const member of members)
      seen.set(member, [...(seen.get(member) ?? []), name]);
  expect([...seen].filter(([, groups]) => groups.length > 1)).toEqual([]);
  for (const member of REQUIRED_RUNTIME_MEMBERS)
    expect(seen.has(member)).toBe(false);
});

function completeStub() {
  const members = [
    ...REQUIRED_RUNTIME_MEMBERS,
    ...Object.values(RUNTIME_CAPABILITY_GROUPS).flat(),
  ];
  const client: Record<string, unknown> = {};
  for (const member of members) client[member] = () => undefined;
  return client as unknown as import("@anthelia/contracts").RuntimeClient;
}

test("the stable surface binds the required members to the API version", () => {
  // The promise and the code are one constant: REQUIRED_RUNTIME_MEMBERS is
  // derived from API_STABLE_SURFACE, so moving a member out of the required
  // set without bumping the version is a change to a single source — and any
  // such change must also update this test's expectation, which is the point.
  expect(API_STABLE_SURFACE.apiVersion).toBe(API_VERSION);
  expect(API_STABLE_SURFACE.requiredMembers).toEqual([
    "start",
    "submit",
    "cancel",
    "snapshot",
    "diagnostic",
    "lastSubmission",
    "respondApproval",
    "respondQuestion",
  ]);
  expect(REQUIRED_RUNTIME_MEMBERS).toEqual(API_STABLE_SURFACE.requiredMembers);
  // The report carries the same version the promise is made under.
  const client = completeStub();
  expect(describeRuntimeCapabilities(client).apiVersion).toBe(API_VERSION);
});

test("a deprecated member surfaces in the report with its replacement", () => {
  // The table is empty today; the mechanism is exercised with an injected
  // deprecation so it cannot rot into an unobservable feature. Patching the
  // global table would make this test order-dependent, so the channel report
  // reads it through describe, and we assert the shape against a fake table
  // via the function that decorates members.
  const client = completeStub();
  const report = describeRuntimeCapabilities(
    client,
    { name: "rpc", routedMembers: new Set() },
    { sessionSnapshot: { replacement: "session.list", since: 1 } },
  );
  const all = [
    ...report.channel!.groups.flatMap((group) => group.members),
    ...report.channel!.requiredMembers,
  ];
  const marked = all.find((member) => member.member === "sessionSnapshot")!;
  expect(marked.deprecated).toEqual({
    replacement: "session.list",
    since: 1,
  });
  expect(
    all.every(
      (member) =>
        member.deprecated === undefined || member.member === "sessionSnapshot",
    ),
  ).toBe(true);
});
