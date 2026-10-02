import { defineService } from "@anthelia/runtime-services";
import type { WorkLedgerController } from "@natalia/work-ledger";

/** The work ledger controller token; lives with the mechanism. */
export const workLedgerController = defineService<WorkLedgerController>(
  "work-ledger.controller",
  { scope: "workspace", capability: "services" },
);
