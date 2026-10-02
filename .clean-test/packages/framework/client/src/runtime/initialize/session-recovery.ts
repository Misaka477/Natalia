import type { InitializeOptions, RuntimeContext } from "@anthelia/substrate";
import { createInitializeRuntime } from "./runtime";
import { SessionRecoveryCoordinator } from "./session-recovery-coordinator";

export async function recoverSession(
  ctx: RuntimeContext,
  options: InitializeOptions,
) {
  const scope = createInitializeRuntime(ctx);
  const coordinator = new SessionRecoveryCoordinator(options, scope);
  return coordinator.run();
}
