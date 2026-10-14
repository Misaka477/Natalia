import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { CapabilityHost } from "../src";

const registration = (id: string) => ({
  id,
  name: id,
  version: "1",
  scope: "workspace" as const,
  grants: ["workflows" as const],
});

test("workspace hosts canonicalize roots", () => {
  // The canonical form is the platform's own: resolve() collapses the
  // ".." and, on Windows, spells the answer drive-absolute — so the
  // expectation is built the same way rather than pinned to "/srv/...".
  expect(
    new CapabilityHost({ workspaceRoot: "/srv/work/../project" }).workspaceRoot,
  ).toBe(resolve("/srv/work/../project"));
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
