export type CapabilityGrant =
  | "tools"
  | "commands"
  | "settings"
  | "settingsSchema"
  | "workflows"
  | "projections"
  | "resources"
  | "adapters"
  | "schedulerJobs"
  | "listeners"
  | "services";

export type CapabilityScope = "process" | "workspace" | "session";

/** Metadata and contribution authority registered by the actual lifecycle owner. */
export type CapabilityRegistration = {
  id: string;
  name: string;
  version: string;
  description?: string;
  scope: CapabilityScope;
  grants: CapabilityGrant[];
  precedence?: number;
};

export type ServiceUpdate = {
  name: string;
  provider: string | undefined;
  providerBefore?: string;
};

export type CapabilityContribution<T = unknown> = {
  capabilityID: string;
  kind: CapabilityGrant;
  name: string;
  payload: T;
};

/**
 * An opaque authority issued once for an owner registration. The closures carry
 * the registry's private token, so constructing a structurally similar object
 * cannot mutate registry storage. Both contribution and owner release are
 * idempotent.
 */
export type CapabilityOwnerHandle = {
  readonly id: string;
  contribute(kind: CapabilityGrant, name: string, payload: unknown): () => void;
  release(): void;
};

export type CapabilityExecutionLease = {
  capabilityIDs: readonly string[];
  release(): void;
};
