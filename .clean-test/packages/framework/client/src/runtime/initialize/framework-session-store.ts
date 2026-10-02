/**
 * Framework subsystem composition — initialize/framework-session-store.ts.
 *
 * The durable session store is a framework-internal subsystem, not a plugin:
 * this module constructs the store controller directly and contributes it as
 * the `session-store.controller` service plus the `/sessions` command, so every
 * runtime member that persists session events keeps resolving the kernel
 * service unchanged. The host owns `init` and close.
 */
import { createSessionStoreController } from "@anthelia/session-store";
import { sessionStoreController } from "@anthelia/session-store";
import type { InitializeOptions, RuntimeContext } from "@anthelia/substrate";
import type { AttachmentService } from "@anthelia/runtime";

export type SessionStoreHandle = { close(): void };

export function wireSessionStore(
  ctx: RuntimeContext,
  options: InitializeOptions,
  attachments: AttachmentService,
): SessionStoreHandle {
  const registry = ctx.state.capabilityRegistry;
  const owner = registry.registerOwner({
    id: "natalia-session-store",
    name: "Session Store",
    version: "1.0.0",
    scope: "workspace",
    grants: ["services", "commands"],
  });
  const controller = createSessionStoreController({
    workspaceRoot: ctx.ports.getWorkspaceRoot(),
    sessionID: ctx.ports.getSessionID,
    sessionDir: options.sessionDir,
    useSqliteStore: options.useSqliteStore,
    title: options.title,
    attachments,
  });
  // The controller binds through the directory; the owner stays for its
  // commands contributions.
  ctx.state.serviceDirectory.provide(sessionStoreController, controller);
  owner.contribute("commands", "sessions", {
    name: "sessions",
    title: "List sessions",
    async run() {
      if (!controller.status().initialized)
        throw new Error("session store is not initialized");
      const listing = (await controller.list())
        .map((item) => `${item.id}  ${item.title}  ${item.events} events`)
        .join("\n");
      return listing || "no TS sessions found in this workspace";
    },
  });
  return {
    close() {
      void controller.close();
    },
  };
}
