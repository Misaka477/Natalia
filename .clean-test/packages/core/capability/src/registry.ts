import { CapabilityLoadError } from "./errors";
import type {
  CapabilityContribution,
  CapabilityGrant,
  CapabilityOwnerHandle,
  CapabilityRegistration,
  CapabilityScope,
  ServiceUpdate,
} from "./types";

type OwnerRecord = {
  registration: CapabilityRegistration;
  token: object;
  contributions: Map<string, CapabilityContribution>;
  released: boolean;
};

/** Authorized contribution storage. It does not execute owner lifecycle code. */
export class CapabilityRegistry {
  private readonly ownersByID = new Map<string, OwnerRecord>();
  private readonly effectiveOwners = new Map<string, string>();
  private readonly effectivePrecedence = new Map<string, number>();
  private readonly serviceListeners = new Set<
    (update: ServiceUpdate) => void
  >();
  private readonly overrideLog: Array<{
    kind: CapabilityGrant;
    name: string;
    winner: string;
    winnerPrecedence: number;
    loser: string;
    loserPrecedence: number;
  }> = [];

  registerOwner(registration: CapabilityRegistration): CapabilityOwnerHandle {
    if (this.ownersByID.has(registration.id))
      throw new CapabilityLoadError(
        registration.id,
        `capability owner "${registration.id}" is already registered`,
      );
    const record: OwnerRecord = {
      registration,
      token: {},
      contributions: new Map(),
      released: false,
    };
    this.ownersByID.set(registration.id, record);
    const handle: CapabilityOwnerHandle = {
      id: registration.id,
      contribute: (kind, name, payload) =>
        this.contribute(record, record.token, kind, name, payload),
      release: () => this.releaseOwner(record, record.token),
    };
    return Object.freeze(handle);
  }

  private contribute(
    record: OwnerRecord,
    token: object,
    kind: CapabilityGrant,
    name: string,
    payload: unknown,
  ): () => void {
    this.assertAuthority(record, token);
    const registration = record.registration;
    if (!registration.grants.includes(kind))
      throw new CapabilityLoadError(
        registration.id,
        `capability owner "${registration.id}" contributed ${kind} "${name}" without the "${kind}" grant`,
      );
    if (!name)
      throw new CapabilityLoadError(
        registration.id,
        `capability owner "${registration.id}" contributed a ${kind} with no name`,
      );
    const key = contributionKey(kind, name);
    const existing = this.effectiveOwners.get(key);
    const ownExisting = existing === registration.id;
    if (existing !== undefined && !ownExisting) {
      const nextPrecedence = registration.precedence ?? 0;
      const previousPrecedence = this.effectivePrecedence.get(key) ?? 0;
      if (nextPrecedence <= previousPrecedence)
        throw new CapabilityLoadError(
          registration.id,
          `capability owner "${registration.id}" cannot contribute ${kind} "${name}": already provided by "${existing}" at precedence ${previousPrecedence}`,
        );
      this.overrideLog.push({
        kind,
        name,
        winner: registration.id,
        winnerPrecedence: nextPrecedence,
        loser: existing,
        loserPrecedence: previousPrecedence,
      });
    }
    const contribution: CapabilityContribution = {
      capabilityID: registration.id,
      kind,
      name,
      payload,
    };
    record.contributions.set(key, contribution);
    this.effectiveOwners.set(key, registration.id);
    this.effectivePrecedence.set(key, registration.precedence ?? 0);
    if (kind === "services")
      this.emitServiceUpdate(name, registration.id, existing);

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (record.released || record.token !== token) return;
      if (record.contributions.get(key) !== contribution) return;
      record.contributions.delete(key);
      if (this.effectiveOwners.get(key) !== registration.id) return;
      this.effectiveOwners.delete(key);
      this.effectivePrecedence.delete(key);
      if (kind === "services") this.emitServiceUpdate(name, undefined);
    };
  }

  private releaseOwner(record: OwnerRecord, token: object): void {
    if (record.released) return;
    this.assertAuthority(record, token);
    record.released = true;
    for (const contribution of record.contributions.values()) {
      const key = contributionKey(contribution.kind, contribution.name);
      if (this.effectiveOwners.get(key) !== record.registration.id) continue;
      this.effectiveOwners.delete(key);
      this.effectivePrecedence.delete(key);
      if (contribution.kind === "services")
        this.emitServiceUpdate(contribution.name, undefined);
    }
    record.contributions.clear();
    this.ownersByID.delete(record.registration.id);
  }

  private assertAuthority(record: OwnerRecord, token: object): void {
    if (
      record.token !== token ||
      record.released ||
      this.ownersByID.get(record.registration.id) !== record
    )
      throw new CapabilityLoadError(
        record.registration.id,
        `capability owner "${record.registration.id}" is released`,
      );
  }

  list(): CapabilityRegistration[] {
    return [...this.ownersByID.values()].map((owner) => owner.registration);
  }

  has(id: string): boolean {
    return this.ownersByID.has(id);
  }

  scopeOf(id: string): CapabilityScope | undefined {
    return this.ownersByID.get(id)?.registration.scope;
  }

  withGrant(grant: CapabilityGrant): string[] {
    return [...this.ownersByID.values()]
      .filter((owner) => owner.registration.grants.includes(grant))
      .map((owner) => owner.registration.id);
  }

  overrides() {
    return [...this.overrideLog];
  }

  contributions<T>(kind: CapabilityGrant): Array<CapabilityContribution<T>> {
    const result: Array<CapabilityContribution<T>> = [];
    for (const owner of this.ownersByID.values())
      for (const contribution of owner.contributions.values())
        if (
          contribution.kind === kind &&
          this.effectiveOwners.get(
            contributionKey(contribution.kind, contribution.name),
          ) === contribution.capabilityID
        )
          result.push(contribution as CapabilityContribution<T>);
    return result;
  }

  contribution<T>(kind: CapabilityGrant, name: string): T | undefined {
    const ownerID = this.ownerOf(kind, name);
    if (!ownerID) return undefined;
    return this.ownersByID
      .get(ownerID)
      ?.contributions.get(contributionKey(kind, name))?.payload as
      | T
      | undefined;
  }

  ownerOf(kind: CapabilityGrant, name: string): string | undefined {
    return this.effectiveOwners.get(contributionKey(kind, name));
  }

  service<T>(name: string): T | undefined {
    return this.contribution<T>("services", name);
  }

  services(): string[] {
    return this.contributions("services").map((entry) => entry.name);
  }

  onServiceUpdate(listener: (update: ServiceUpdate) => void): () => void {
    this.serviceListeners.add(listener);
    return () => this.serviceListeners.delete(listener);
  }

  private emitServiceUpdate(
    name: string,
    provider: string | undefined,
    providerBefore?: string,
  ): void {
    const update: ServiceUpdate = { name, provider };
    if (providerBefore !== undefined) update.providerBefore = providerBefore;
    for (const listener of this.serviceListeners)
      try {
        listener(update);
      } catch {
        // One observer cannot block storage updates or other observers.
      }
  }
}

export type CapabilityRegistryView = Pick<
  CapabilityRegistry,
  | "list"
  | "has"
  | "scopeOf"
  | "withGrant"
  | "overrides"
  | "contributions"
  | "contribution"
  | "ownerOf"
  | "service"
  | "services"
  | "onServiceUpdate"
>;

export type CapabilityRegistryHost = CapabilityRegistryView &
  Pick<CapabilityRegistry, "registerOwner">;

function contributionKey(kind: CapabilityGrant, name: string): string {
  return `${kind}\u0000${name}`;
}
