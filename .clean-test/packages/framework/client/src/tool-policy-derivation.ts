/**
 * Tool policy derivation.
 *
 * These are the pure config→policy computations that build a hook layer's
 * allow/exclude sets before they are handed to the tool policy service. Keeping
 * the derivation separate from the hook-layer construction makes the
 * agent/mode/profile precedence rules testable without the policy service.
 */
import type { ConfigV3, PermissionProfile } from "@anthelia/contracts";
import type { AgentDefinition } from "@anthelia/agent";

type RuntimeMode = ConfigV3["agentModes"][string];

export function deriveAgentToolPolicy(input: {
  agent: AgentDefinition | undefined;
  mode: RuntimeMode | undefined;
}): { allow: string[]; exclude: string[] } {
  const { agent, mode } = input;
  return {
    allow: [
      ...(agent?.allowedTools ?? mode?.allowedTools ?? []),
      ...(agent?.permissions?.tools?.allow ?? []),
    ],
    exclude: [
      ...(agent?.excludedTools ?? mode?.excludedTools ?? []),
      ...(agent?.permissions?.tools?.exclude ?? []),
    ],
  };
}

export function deriveProfileToolPolicy(input: {
  profile: PermissionProfile | RuntimeMode | undefined;
}): { allow: string[] | undefined; exclude: string[] | undefined } {
  const { profile } = input;
  const mode = profile && "allowedTools" in profile ? profile : undefined;
  const legacy = profile && "permissions" in profile ? profile : undefined;
  return {
    allow: mode?.allowedTools ?? legacy?.permissions?.tools?.allow,
    exclude: mode?.excludedTools ?? legacy?.permissions?.tools?.exclude,
  };
}
