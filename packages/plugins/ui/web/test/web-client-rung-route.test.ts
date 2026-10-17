/**
 * Every runtime method the WEB client calls must be in its RPC table.
 *
 * Measured defect this pins: `setSandboxRung` was missing from
 * `apps/web/src/runtime-rpc.ts`. The UI called
 * `props.ctx.runtime.setSandboxRung?.(…)`, the proxy answered `undefined`
 * because the face was never synthesized, so moving the permission selector
 * wrote NOTHING to the runtime — no session mode change, no
 * `context.instructions` record — while the separate `updateConfig` write
 * produced a reload notice. The user's report ("I switch and only see the reload,
 * the UI does not change") is exactly that shape.
 *
 * The table is a hand-maintained map, so this asserts the row rather than the
 * mechanism: a method the ladder's control depends on must be reachable.
 */
import { expect, test } from "bun:test";
import { join } from "node:path";

// This test lives in packages/plugins/ui/web/test, so the repository root is five
// levels up.
const repoRoot = join(import.meta.dir, "..", "..", "..", "..", "..");

const web = await Bun.file(
  join(repoRoot, "apps", "web", "src", "runtime-rpc.ts"),
).text();
const transport = await Bun.file(
  join(repoRoot, "packages", "hosts", "transport", "src", "rpc.ts"),
).text();

test("the web client can reach the rung setter", () => {
  expect(web).toContain('setSandboxRung: "sandbox.rung.set"');
});

test("the transport serves the route the table names", () => {
  // Both halves have to agree: the table's route and the handler's branch.
  expect(transport).toContain('"sandbox.rung.set": "setSandboxRung"');
  expect(transport).toContain('body.method === "sandbox.rung.set"');
  // And the rung's approval axis is validated at the edge, not trusted.
  expect(transport).toContain(
    "sandbox.rung.set.params.approval must be one of",
  );
});
