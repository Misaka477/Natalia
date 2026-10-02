import type { CapabilityRegistryHost } from "@anthelia/capability";
import type { ServiceBindings, ServiceScope } from "@anthelia/runtime-services";

/**
 * Backs a service directory with the capability registry's service bindings.
 *
 * Each provide registers its own owner: the registry's contribution model
 * already carries per-owner disposal, listener notification and precedence
 * resolution, so a service bound through the directory participates in exactly
 * the semantics plugin-provided services always had. The alternative — one
 * long-lived owner for every directory binding — would couple unrelated
 * services' lifetimes for no gain.
 */
export function createCapabilityServiceBindings(
  registry: CapabilityRegistryHost,
): ServiceBindings {
  return {
    provide: (id, value, scope) => {
      const owner = registry.registerOwner({
        id: `service:${id}`,
        name: id,
        version: "1.0.0",
        scope: scope ?? "process",
        grants: ["services"],
      });
      owner.contribute("services", id, value);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        owner.release();
      };
    },
    get: <T>(id: string) => registry.service<T>(id),
  };
}

/** The scope names the registry accepts, re-exported for call-site clarity. */
export type { ServiceScope };
