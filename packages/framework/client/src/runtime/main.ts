import { installDefaultLogExporter } from "@anthelia/logging";
import type { RuntimeServiceClient } from "@anthelia/runtime-services";
import {
  terminalApprovalScope,
  terminalInputRisk,
} from "@anthelia/runtime-services";
import { startMemoryTraceSampler } from "@anthelia/runtime";
import { createClientSurface } from "./client-surface";
import { createCompositionContext } from "./composition/state";
import { wireFoundation } from "./composition/foundation";
import { wireFeatures } from "./composition/features";
import { wireServices } from "./composition/services";
import { wireExecution } from "./composition/execution";
import { wireInitialize } from "./composition/initialize";
import type { RealRuntimeClientOptions } from "@anthelia/substrate";

export { EGRESS_ADVISORY } from "./commands";
export { terminalApprovalScope, terminalInputRisk };
export type { RealRuntimeClientOptions } from "@anthelia/substrate";

/** Explicit composition root for the production runtime client. */
export function createRealRuntimeClient(
  options: RealRuntimeClientOptions = {},
): RuntimeServiceClient {
  const ctx = createCompositionContext(options);
  // The logger's sink, installed before anything can log. Without it every
  // log point in the framework is a no-op — the tables are read, the record
  // is built, and nothing is emitted — so `NATALIA_LOG` would configure a
  // verbosity nobody could observe. Idempotent, so a second boot path (tests,
  // workers) cannot double-print.
  installDefaultLogExporter();
  // Periodic RSS/heap samples when NATALIA_MEMORY_TRACE=1 (no-op otherwise).
  startMemoryTraceSampler();
  wireFoundation(ctx);
  const features = wireFeatures(ctx, options);
  const services = wireServices(ctx, options);
  const execution = wireExecution(ctx, options);
  wireInitialize(
    ctx,
    options,
    { ...features, ...execution },
    createRealRuntimeClient,
  );
  ctx.ports.ensureReady = services.ensureReady;
  return createClientSurface(ctx, options);
}
