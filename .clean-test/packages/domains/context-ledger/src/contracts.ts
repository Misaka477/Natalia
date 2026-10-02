import type { RuntimeEvent } from "@anthelia/contracts";
import type { ContextLedger } from "@anthelia/runtime";

/** Context ledger contracts, moved from runtime-services with the token. */

export interface ContextLedgerFactory {
  create(): RuntimeContextLedger;
  restore(context: RuntimeContextLedger, events: RuntimeEvent[]): void;
}

export type RuntimeContextLedger = ContextLedger;
