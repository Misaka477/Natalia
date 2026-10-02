/**
 * Framework subsystem composition — initialize/framework-governance-ledger.ts.
 *
 * The governance ledger (constitution, decision, evidence and completion
 * writers) is a framework-internal subsystem, not a plugin: this module
 * constructs the controller directly and contributes it as the
 * `governance-ledger.controller` service. It depends on the work-ledger
 * subsystem, which is wired before it.
 */
import { createGovernanceLedgerController } from "@natalia/governance-ledger";
import type { RuntimeContext } from "@anthelia/substrate";
import { governanceLedgerController } from "@natalia/governance-ledger";

export function wireGovernanceLedger(ctx: RuntimeContext): void {
  const registry = ctx.state.capabilityRegistry;
  const owner = registry.registerOwner({
    id: "natalia-governance-ledger",
    name: "Governance Ledger",
    version: "1.0.0",
    scope: "workspace",
    grants: ["services"],
  });
  ctx.state.serviceDirectory.provide(
    governanceLedgerController,
    createGovernanceLedgerController(),
  );
}
