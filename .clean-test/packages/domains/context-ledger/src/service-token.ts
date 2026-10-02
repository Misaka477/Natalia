import { defineService } from "@anthelia/runtime-services";
import type { ContextLedgerFactory } from "@natalia/context-ledger";

/** The context ledger factory token; lives with the mechanism. */
export const contextLedgerFactory = defineService<ContextLedgerFactory>(
  "context-ledger.factory",
  { scope: "workspace", capability: "services" },
);
