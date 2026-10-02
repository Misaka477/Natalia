import { defineService } from "@anthelia/runtime-services";
import type { GovernanceLedgerController } from "@natalia/governance-ledger";

/** The governance ledger controller token; lives with the mechanism. */
export const governanceLedgerController =
  defineService<GovernanceLedgerController>("governance-ledger.controller", {
    scope: "workspace",
    capability: "services",
  });
