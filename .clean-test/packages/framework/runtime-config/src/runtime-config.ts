/**
 * The runtime's effective config — framework-internal, not a plugin.
 *
 * The resolved config is contributed as the `runtime.config` service by name;
 * the runtime host refreshes that contribution on reload so service
 * subscribers observe the replacement. This package owns only the service key
 * and the value contract; the host owns the lifecycle.
 */
import type { ConfigV3 } from "@anthelia/contracts";

export const RUNTIME_CONFIG_SERVICE = "runtime.config";

/** The config value contributed as `RUNTIME_CONFIG_SERVICE`. */
export type RuntimeConfigService = ConfigV3;
