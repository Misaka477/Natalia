import { expect, test } from "bun:test";
import { CapabilityHost } from "../src";

const registration = (id: string) => ({
  id,
  name: id,
  version: "1",
  scope: "workspace" as const,
  grants: ["workflows" as const],
});

test("workspace hosts canonicalize roots", () => {
  expect(
    new CapabilityHost({ workspaceRoot: "/srv/work/../project" }).workspaceRoot,
  ).toBe("/srv/project");
});

test("host leases execution without running owner cleanup", () => {
  const host = new CapabilityHost();
  const owner = host.registerOwner(registration("review"));
  owner.contribute("workflows", "review", {});
  const lease = host.acquireExecutionLease("review");
  owner.release();
  expect(host.has("review")).toBe(false);
  expect(() => host.acquireExecutionLease("review")).toThrow(
    "is not visible for execution",
  );
  lease.release();
  lease.release();
});

test("host disposal releases storage and refuses new owners", () => {
  const host = new CapabilityHost();
  host
    .registerOwner(registration("review"))
    .contribute("workflows", "review", {});
  host.dispose();
  host.dispose();
  expect(host.list()).toEqual([]);
  expect(() => host.registerOwner(registration("late"))).toThrow(
    "capability host is disposed",
  );
});
