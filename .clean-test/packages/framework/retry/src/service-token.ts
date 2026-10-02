import type { RetryService } from "@anthelia/runtime";
import { defineService } from "@anthelia/runtime-services";

/**
 * The retry service token. The id is the wire name the runtime has always
 * resolved; the token adds the typed face and lives in the package that owns
 * the mechanism, so consumers import the service and its name from one place.
 */
export const retryService = defineService<RetryService>("retry.service", {
  scope: "workspace",
  capability: "services",
});
