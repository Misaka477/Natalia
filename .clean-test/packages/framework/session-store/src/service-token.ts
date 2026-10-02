import type { SessionStoreController } from "./contracts";
import { defineService } from "@anthelia/runtime-services";

/**
 * The session store controller token; lives with the mechanism. With this one
 * landed, the central service-id table is empty and every service the runtime
 * resolves speaks its token.
 */
export const sessionStoreController = defineService<SessionStoreController>(
  "session-store.controller",
  { scope: "workspace", capability: "services" },
);
