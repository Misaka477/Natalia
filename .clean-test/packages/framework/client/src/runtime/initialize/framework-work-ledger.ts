/**
 * Framework subsystem composition — initialize/framework-work-ledger.ts.
 *
 * The work ledger (plan, drift and work graph event writers) is a
 * framework-internal subsystem, not a plugin: this module constructs the
 * controller directly and contributes it as the `work-ledger.controller`
 * service so engineering-intelligence and tool-execution members resolve it
 * unchanged.
 */
import { createWorkLedgerController } from "@natalia/work-ledger";
import { workLedgerController } from "@natalia/work-ledger";
import type { RuntimeEvent } from "@anthelia/contracts";
import type { RuntimeContext } from "@anthelia/substrate";
import type { WorkLedgerController } from "@natalia/work-ledger";

export function wireWorkLedger(ctx: RuntimeContext): WorkLedgerController {
  const registry = ctx.state.capabilityRegistry;
  const owner = registry.registerOwner({
    id: "natalia-work-ledger",
    name: "Work Ledger",
    version: "1.0.0",
    scope: "workspace",
    grants: ["services"],
  });
  const controller = createWorkLedgerController({
    openFindingIDs: () =>
      new Set(
        (ctx.ports.getSession()?.events ?? [])
          .filter(
            (
              event,
            ): event is Extract<
              RuntimeEvent,
              { type: "drift.finding_opened" }
            > => event.type === "drift.finding_opened",
          )
          .map((event) => event.findingID),
      ),
  });
  ctx.state.serviceDirectory.provide(workLedgerController, controller);
  return controller;
}
